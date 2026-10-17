"""把「不感兴趣」前端脚本注入 KiraAI WebUI 产物目录（data/dist）。

只依赖标准库，可脱离 KiraAI 进程单独运行：

    python injector.py                # 同步脚本 + 注入 index.html
    python injector.py --remove       # 移除注入（恢复原状）
    python injector.py --dist <dir>   # 手动指定 dist 目录

写入产物：
    <dist>/store-purifier.js     前端注入脚本（从本插件 web/ 同步）
    <dist>/index.html                 追加 <script src="/store-purifier.js" defer></script>

为什么改 dist 也能立即生效（且不需重启）：
  - webui/routes/auth.py 的 serve_spa() 每次请求都重新读 dist/index.html 并带 no-cache 头；
  - 同文件里的 SPAStaticFallbackMiddleware 对「不含 / 的单段根文件名」会直接从 dist
    返回文件，所以 /store-purifier.js 无论插件是否加载都能取到。
  官方升级会用整包覆盖 dist（core/utils/dist_checker.py），因此插件带守护轮询自动重注入。

安全性约定：
  - index.html 只接受合法 UTF-8、只做「加/减一段带标记的块」，不做任何其它改写；
    换行风格（CRLF/LF）按原样写回，标准文档上 sync→remove 逐字节还原；
  - 官方升级可能在读与写之间把整个 dist 换掉，写回前复核 stat，变了就放弃这一轮；
  - 写入走「临时文件 + 原子替换」，服务端永远读不到半截文件。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

SCRIPT_NAME = "store-purifier.js"
MARK_START = "<!-- store-purifier:start -->"
MARK_END = "<!-- store-purifier:end -->"

# 2.x 时代的注入标识。线上 dist 的 index.html 里可能还留着旧块，dist 根目录也可能
# 躺着旧脚本；改名之后必须仍然认得出来并清掉，否则页面上会同时挂着新旧两份脚本。
LEGACY_SCRIPT_NAMES = ("kira-not-interested.js",)
LEGACY_MARK_START = "<!-- kira-not-interested:start -->"
LEGACY_MARK_END = "<!-- kira-not-interested:end -->"

# 脚本 URL 上带版本号：浏览器对同名静态文件会走启发式缓存，
# 版本一变 URL 就变，用户强刷一次之后永远不会再吃到旧脚本。
# 兼容单双引号、任意空白与「=」两侧无空格（压缩过的脚本），但只认形如 1.2.3 的值，
# 以免把文件头注释里的普通文本当成版本号。
_VERSION_RE = re.compile(r"version\s*:\s*[\"']([0-9][0-9A-Za-z.+-]{0,31})[\"']")
_ASSIGN_RE = re.compile(r"__storePurifier\s*=\s*\{", re.S)

PLUGIN_DIR = Path(__file__).resolve().parent
SOURCE_SCRIPT = PLUGIN_DIR / "web" / SCRIPT_NAME
BACKUP_DIR = PLUGIN_DIR / "backup"
# 插件商店源文件：由 manifest.json 生成，不手改
STORE_FILE = PLUGIN_DIR / "store.json"

# sync/remove 会对同一份 dist 做「写脚本 + 改 index」的两步操作。插件卸载时
# terminate 会先取消守护任务，但 asyncio.to_thread 里的那轮 sync 停不下来，
# 于是它可能和 remove 交错：remove 删掉脚本后 sync 才写回 index（页面 404），
# 或 sync 落在 remove 之后（禁用后功能还在）。把两个操作串行化即可。
_IO_LOCK = threading.Lock()

def _block_re(mark_start: str, mark_end: str) -> re.Pattern:
    """完整块：起止标记 + 中间内容。中间内容另做「像不像我们写的」校验（见 _block_inner_ok），
    避免人为把两个标记放到文件首尾时把中间的整篇 HTML 当成注入块删掉。
    """
    return re.compile(
        r"[ \t]*" + re.escape(mark_start) + r"((?:(?!" + re.escape(mark_end) + r").)*?)" + re.escape(mark_end) + r"[ \t]*\r?\n?",
        re.S,
    )


def _stray_re(mark_start: str, mark_end: str, script_name: str) -> re.Pattern:
    """残缺标记（只有 start / 只有 end / 两个顺序颠倒）：连同紧随其后的那条 script 一起删。

    只删标记行会把孤立的 <script> 留在页面里，remove() 再也清不掉。
    """
    return re.compile(
        # 标记后的 [^\n<]* 在遇到 "<" 处停下：标记与真实内容挤在同一行时（人为造出的
        # <p>a</p> <!-- start --><p>REAL</p>），不应该把 <p>REAL</p> 一起删掉。
        r"[ \t]*(?:" + re.escape(mark_start) + r"|" + re.escape(mark_end) + r")[^\n<]*\r?\n?"
        r"(?:[ \t]*<script\b[^>]*" + re.escape(script_name) + r"[^>]*>[ \t]*</script>[ \t]*(?:\r?\n)?)?",
        re.I,
    )


_BLOCK_RE = _block_re(MARK_START, MARK_END)
_STRAY_RE = _stray_re(MARK_START, MARK_END, SCRIPT_NAME)
_LEGACY_BLOCK_RE = _block_re(LEGACY_MARK_START, LEGACY_MARK_END)
_LEGACY_STRAY_RE = _stray_re(LEGACY_MARK_START, LEGACY_MARK_END, LEGACY_SCRIPT_NAMES[0])
_HEAD_RE = re.compile(r"[ \t]*</head\s*>", re.I)
_BODY_RE = re.compile(r"[ \t]*<body(?:\s[^>]*)?>", re.I)


def _safe_version(value: str) -> str:
    """版本号要拼进 HTML 属性，只留安全字符。"""
    # 只留 ASCII 安全字符：版本号要拼进 HTML 属性与 URL 查询串，中文虽然无害，
    # 但出现在 ?v= 里没有意义，还会在日志与代理里被转义得难以排查。
    return re.sub(r"[^0-9A-Za-z.+-]", "", str(value or ""))[:32]


def _manifest_version() -> str:
    """插件清单里的版本号（脚本里读不到版本号时的兜底）。"""
    try:
        meta = json.loads((PLUGIN_DIR / "manifest.json").read_text(encoding="utf-8"))
        return _safe_version(meta.get("version") or "")
    except Exception:
        return ""


def _raw_base(repo: str) -> str:
    """把 GitHub 仓库地址换成 raw 文件前缀；不是 GitHub 地址就返回空串。"""
    url = str(repo or "").strip().rstrip("/")
    marker = "github.com/"
    if marker not in url:
        return ""
    slug = url.split(marker, 1)[1]
    if slug.endswith(".git"):
        slug = slug[: -len(".git")]
    return "https://raw.githubusercontent.com/%s/main/" % slug


def build_store() -> dict:
    """按 manifest.json 生成插件商店源文件的内容。

    版本号只留一个来源：改完 manifest 跑一次 python injector.py --store，
    store.json 跟着变，商店里不会出现旧版本号、更新检测也不会误判。
    """
    meta = json.loads((PLUGIN_DIR / "manifest.json").read_text(encoding="utf-8"))
    repo = str(meta.get("repo") or "").strip()
    raw = _raw_base(repo)
    entry = {
        "plugin_id": meta.get("plugin_id") or PLUGIN_DIR.name,
        "display_name": meta.get("display_name") or "",
        "version": _safe_version(meta.get("version") or ""),
        "author": meta.get("author") or "",
        "description": meta.get("description") or "",
        "repo": repo,
        "icon": (raw + str(meta.get("icon"))) if raw and meta.get("icon") else "",
        "icon_dark": (raw + str(meta.get("icon-dark"))) if raw and meta.get("icon-dark") else "",
        "tags": [str(tag) for tag in (meta.get("tags") or []) if tag],
        "core_version": str(meta.get("core_version") or ""),
        "locales": meta.get("locales") or {},
    }
    # 空字段不写：extract_plugins 对缺省值本来就有一致的处理，留空串只是噪音
    entry = {key: value for key, value in entry.items() if value not in ("", [], {})}
    return {"plugins": {entry["plugin_id"]: entry}}


def write_store() -> Tuple[Path, dict]:
    """重新生成 store.json，返回 (路径, 内容)。"""
    data = build_store()
    STORE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return STORE_FILE, data


def _script_version(data: bytes) -> str:
    """从脚本源码里读出 `version: 'x.y.z'`，用于给 <script src> 加缓存破坏参数。

    优先取 `window.__storePurifier = {...}` 字面量里的那一份（文件头注释里写
    "version: ..." 时不会被误认），取不到再全文找第一条形如版本号的值。
    """
    # errors="replace" 保证 decode 不会抛异常，这里不需要再包一层 try
    text = data.decode("utf-8", errors="replace")
    for match in _ASSIGN_RE.finditer(text):
        window = text[match.end(): match.end() + 400]
        found = _VERSION_RE.search(window)
        if found:
            return _safe_version(found.group(1))
    found = _VERSION_RE.search(text)
    return _safe_version(found.group(1)) if found else ""


def make_snippet(version: str = "") -> str:
    """生成要插进 </head> 前的注入块（起止标记 + 带版本号的 script 标签）。"""
    safe = _safe_version(version)
    query = ("?v=" + safe) if safe else ""
    return (
        "    " + MARK_START + "\n"
        '    <script src="/' + SCRIPT_NAME + query + '" defer></script>\n'
        "    " + MARK_END + "\n"
    )


def _block_inner_ok(inner: str, script_name: str = SCRIPT_NAME) -> bool:
    """判断两个标记之间的内容确实是我们的注入块，而不是被人为跨接的一大段 HTML。"""
    return len(inner) <= 1000 and script_name in inner and "<!--" not in inner


def _count_blocks(html: str) -> int:
    return sum(1 for match in _BLOCK_RE.finditer(html) if _block_inner_ok(match.group(1)))


def find_dist_dir() -> Optional[Path]:
    """定位 WebUI 产物目录：优先用 KiraAI 的路径配置，失败则按插件位置推断。"""
    try:
        from core.utils.path_utils import get_webui_dist_path  # type: ignore

        candidate = Path(get_webui_dist_path())
        if candidate.is_dir():
            return candidate
    except Exception:
        pass
    try:
        # <root>/data/plugins/<plugin_id>/injector.py -> <root>/data/dist
        candidate = PLUGIN_DIR.parents[1] / "dist"
        if candidate.is_dir():
            return candidate
    except Exception:
        pass
    return None


def _drop_quietly(path: Path) -> None:
    """删掉临时文件；不存在或删不掉（被占用）都不影响主流程。"""
    try:
        path.unlink()
    except OSError:
        pass


def _clean_stale_tmp(path: Path) -> None:
    """清掉本进程遗留的临时文件（写入中途进程被杀才会留下）。

    只认带本进程 pid 的名字：别的进程可能正写着它自己的临时文件，不能动。
    """
    prefix = path.name + ".kn-tmp-" + str(os.getpid()) + "-"
    try:
        for stale in path.parent.glob(path.name + ".kn-tmp-*"):
            if not stale.name.startswith(prefix):
                continue
            if stale.is_file():
                _drop_quietly(stale)
    except OSError:
        pass


def _same_stat(path: Path, st: os.stat_result) -> bool:
    """path 的 mtime/size 是否仍等于 st（读不到就算变了，调用方会跳过这一轮）。"""
    try:
        now = path.stat()
    except OSError:
        return False
    return (now.st_mtime_ns, now.st_size) == (st.st_mtime_ns, st.st_size)


def _write_bytes(path: Path, data: bytes, verify: Optional[Callable[[], bool]] = None) -> bool:
    """先写临时文件再原子替换，避免服务端读到半截内容。

    Windows 上目标文件可能正被 KiraAI 读取（serve_spa 每次请求都读 index.html），
    os.replace 会短暂抛 PermissionError，这里小间隔重试几次再放弃。

    verify 在 os.replace 前一刻调用：建 tmp、写 8KB、fsync 在 SMB 上要几十毫秒，
    调用方「读完再写回」的复核覆盖不到这一段。返回 False 表示已放弃覆盖（临时文件已删）。
    """
    # pid + 随机串：守护线程、手工 CLI、未来可能的并发调用各写各的临时文件，
    # 最后一次性 os.replace，谁都读不到半截内容，也不会互相覆盖同一个 tmp。
    tmp = path.with_name(path.name + ".kn-tmp-" + str(os.getpid()) + "-" + uuid.uuid4().hex[:8])
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError:
                # SMB/部分网络盘不支持 fsync（EINVAL）：内容已 flush，不能因此判写失败
                pass
    except OSError:
        _drop_quietly(tmp)
        raise
    if verify is not None and not verify():
        _drop_quietly(tmp)
        return False
    last: Optional[OSError] = None
    for _ in range(5):
        try:
            os.replace(tmp, path)
            return True
        except OSError as exc:
            last = exc
            time.sleep(0.05)
    _drop_quietly(tmp)
    if last is not None:
        raise last
    return False


def _encode_index(html: str, crlf: bool) -> bytes:
    """按原文件的换行风格写回。"""
    text = html.replace("\n", "\r\n") if crlf else html
    return text.encode("utf-8")


def _decode_index(raw: bytes) -> Optional[str]:
    """严格 UTF-8 解码。

    以前的实现遇到非 UTF-8 会退回 errors="replace"，U+FFFD 直接被写回文件，
    原字节永久丢失（GBK 的 index.html 会变成乱码）。现在一律拒绝对这种文件动刀。
    """
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _uses_crlf(raw: bytes) -> bool:
    """文件是否通篇 CRLF（混用时按 LF 处理，避免把一半行改成 CRLF）。"""
    return b"\n" in raw and raw.count(b"\n") == raw.count(b"\r\n")


def _load_index(index: Path) -> Tuple[str, os.stat_result, bool]:
    """读取 index.html 并严格解码，返回 (换行已统一为 \n 的 html, 读盘时的 stat, 原文件是否 CRLF)。

    读失败抛 OSError、非 UTF-8 抛 ValueError —— sync 和 remove 对这两种情况的报告文案
    不一样，翻成哪种措辞交给调用方。
    """
    raw = index.read_bytes()
    st = index.stat()
    html = _decode_index(raw)
    if html is None:
        raise ValueError("index.html is not valid UTF-8")
    crlf = _uses_crlf(raw)
    return (html.replace("\r\n", "\n") if crlf else html), st, crlf


def _backup_target(dist: Path) -> Path:
    """备份文件名按 dist 路径区分。

    早先所有 dist 共用一个 backup/index.html.orig：用 --dist 指向临时目录做冒烟或
    测试时，那份无关的 index.html 会把真正的线上原版备份顶掉，回滚时拿到的是假文件。
    """
    key = hashlib.sha1(os.path.normcase(str(dist)).encode("utf-8", "replace")).hexdigest()[:8]
    return BACKUP_DIR / ("index.%s.orig" % key)


def _backup_index(index: Path, html: str, report: Dict[str, object]) -> None:
    """在官方原版 index.html 上留底，便于人工回滚。

    只在文件里没有我们的标记时才刷新备份：那说明它是官方刚写下来的原版，
    包括官方升级整包覆盖之后（此时旧备份已经过期，不刷新会误导回滚）。

    判据是「任一标记存在」而不是 is_injected()：文件里只残留一个 START 标记时，
    它已经不再是原版，拿它覆盖备份等于把脏文件存成"官方原版"，回滚就回不去了。
    """
    if _has_any_mark(html):
        return
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        target = _backup_target(index.parent)
        stale = False
        if target.exists():
            try:
                old = _decode_index(target.read_bytes())
            except OSError:
                old = None
            stale = old != html
        if not target.exists() or stale:
            shutil.copyfile(index, target)
        report["backup"] = str(target)
    except OSError as exc:
        # 备份失败不该拦住注入，但必须让调用方看得见（否则用户以为有备份）
        report["backup_error"] = str(exc)


def _has_any_mark(html: str) -> bool:
    """文件里是否残留任意一代标记（含只剩一半的残缺标记）。"""
    return any(m in html for m in (MARK_START, MARK_END, LEGACY_MARK_START, LEGACY_MARK_END))


def _has_legacy_mark(html: str) -> bool:
    """是否还留着 2.x 旧标记。

    sync 的 already 短路必须看它：页面上"新块已是最新"和"旧块还在"能同时成立，
    只看当前标记就会直接放行，旧块永远留在文档里（页面白多一个 404 请求）。
    """
    return LEGACY_MARK_START in html or LEGACY_MARK_END in html


def _drop_legacy_scripts(dist: Path, html: str, report: Dict[str, object]) -> None:
    """删掉 dist 里已经没人引用的 2.x 旧脚本文件。

    改名后 sync 会剥掉旧块，剥完旧脚本就没人引用了；不删它会一直躺在 dist 根目录，
    既占着那个 URL，也让下次排查多一个迷惑项（README 承诺升级时一并清理）。
    文档里仍出现旧脚本名（有人手动挂过）就不动。
    """
    dropped = []
    for name in LEGACY_SCRIPT_NAMES:
        if name in html:
            continue
        stale = dist / name
        try:
            if stale.is_file():
                stale.unlink()
                dropped.append(name)
        except OSError:
            continue
    if dropped:
        report["legacy_script_removed"] = dropped


def _strip_injection(html: str) -> str:
    """摘掉注入块与任何残缺标记（当前标记与 2.x 旧标记各剥一遍）。

    标准文档上与原文件逐字节一致；旧标记也要剥，否则改名后旧块会永远留在页面上。
    两套标记走同一段逻辑，再加一代旧名时只要往下面的元组里补一行。
    """
    for block_re, stray_re, script_name in (
        (_BLOCK_RE, _STRAY_RE, SCRIPT_NAME),
        (_LEGACY_BLOCK_RE, _LEGACY_STRAY_RE, LEGACY_SCRIPT_NAMES[0]),
    ):
        # 默认参数绑定，避免闭包在循环里共享同一个 script_name
        html = block_re.sub(
            lambda match, name=script_name: "" if _block_inner_ok(match.group(1), name) else match.group(0),
            html,
        )
        html = stray_re.sub("", html)
    return html


def _comment_spans(html: str):
    """HTML 注释的 [start, end) 区间。

    注释里的 </head>、<body> 不是真标签：正则若照单全收，注入块会被塞进注释内部，
    页面看起来"已注入"，脚本却永远不会加载，下一轮又因为块已存在而短路。
    """
    spans = []
    pos = 0
    while True:
        start = html.find("<!--", pos)
        if start < 0:
            break
        end = html.find("-->", start + 4)
        if end < 0:
            spans.append((start, len(html)))
            break
        spans.append((start, end + 3))
        pos = end + 3
    return spans


def _in_spans(spans, pos: int) -> bool:
    for start, end in spans:
        if start <= pos < end:
            return True
        if start > pos:
            break
    return False


def _insert_snippet(html: str, snippet: str) -> str:
    """把注入块插到 </head> 之前；没有 head 的残缺页面另行安置。

    优先级：</head> 前 → <body> 前 → 文件末尾。绝不能插到文件最前面，
    否则 <!doctype html> 不再是首行，浏览器会退到怪异模式（quirks mode），
    整个 WebUI 的布局都会变。
    """
    comments = _comment_spans(html)
    for match in _HEAD_RE.finditer(html):
        before = html[: match.start()]
        # head 里的内联脚本如果写了字面量 "</head>"，正则会把块插进 JS 字符串里，
        # 页面脚本当场语法错误 —— 跳过落在 <script>…</script> 内部的命中（标签大小写不敏感）。
        lowered = before.lower()
        if lowered.rfind("<script") > lowered.rfind("</script>"):
            continue
        if _in_spans(comments, match.start()):
            continue
        return before + snippet + match.group(0) + html[match.end():]
    for match in _BODY_RE.finditer(html):
        if _in_spans(comments, match.start()):
            continue
        return html[: match.start()] + snippet + html[match.start():]
    # 末尾追加不补换行：snippet 自带行首缩进，摘除时正则的 [ \t]* 会把缩进一起吃掉，
    # 这样「没有 head/body 的残缺文件」也能逐字节还原。
    # 已知边界：原文若以空格/制表符结尾，这批空白会和 snippet 的缩进连成一片被一并摘除，
    # remove 后比原文少几个空白字节。真实 index.html 以 </html>\n 结尾，不会走到这里。
    return html + snippet


def is_injected(html: str) -> bool:
    """index.html 里是否已有**完整且确实是我们的**注入块。

    只判「两个标记都存在」是不够的：标记顺序颠倒、被注释掉的残片、人为跨接首尾，
    都会让这个函数误报 True，进而让备份逻辑不再刷新（回滚拿到的是脏文件）。
    """
    for match in _BLOCK_RE.finditer(html):
        if _block_inner_ok(match.group(1)):
            return True
    return False


def sync(dist_dir: Optional[Path] = None, source: Optional[Path] = None) -> Dict[str, object]:
    """同步脚本文件并确保 index.html 里有注入标签。返回执行报告。

    与 remove() 互斥：两者都要写同一份 dist，交错执行会留下「块在脚本没了」的 404
    或「卸载后功能还在」的残留（见 _IO_LOCK 的说明）。
    """
    with _IO_LOCK:
        return _sync(dist_dir, source)


def _sync(dist_dir: Optional[Path] = None, source: Optional[Path] = None) -> Dict[str, object]:
    src = Path(source) if source is not None else SOURCE_SCRIPT
    dist = Path(dist_dir) if dist_dir is not None else find_dist_dir()
    report: Dict[str, object] = {
        "dist": str(dist) if dist else None,
        "script_written": False,
        "injected": False,
        "already": False,
        "error": None,
    }

    if dist is None or not dist.is_dir():
        report["error"] = "dist directory not found"
        return report
    if not src.is_file():
        report["error"] = "source script not found: %s" % src
        return report

    try:
        data = src.read_bytes()
    except OSError as exc:
        report["error"] = "read source script failed: %s" % exc
        return report

    index = dist / "index.html"
    if not index.is_file():
        # 先确认 index.html 在，再动 dist：目录残缺时不该往里丢一个没人引用的孤立脚本。
        report["error"] = "index.html not found in dist"
        return report

    _clean_stale_tmp(dist / SCRIPT_NAME)
    _clean_stale_tmp(index)
    target = dist / SCRIPT_NAME
    try:
        current = target.read_bytes() if target.is_file() else None
    except OSError:
        current = None
    if current != data:
        try:
            _write_bytes(target, data)
            report["script_written"] = True
        except OSError as exc:
            report["error"] = "write script failed: %s" % exc
            return report

    try:
        html, st0, crlf = _load_index(index)
    except OSError as exc:
        report["error"] = "read index.html failed: %s" % exc
        return report
    except ValueError:
        report["error"] = "index.html is not valid UTF-8; refusing to modify it"
        return report

    script_version = _script_version(data)
    manifest_version = _manifest_version()
    version = script_version or manifest_version
    report["version"] = version
    if script_version and manifest_version and script_version != manifest_version:
        # 真正决定 ?v= 的是脚本里的版本号；清单落后时浏览器可能还在吃旧脚本，必须可见
        report["version_mismatch"] = {"script": script_version, "manifest": manifest_version}

    snippet = make_snippet(version)
    # 已注入且版本号一致才算"无需改动"；版本升级时重写，URL 里带 ?v= 绕开浏览器缓存。
    # 但只在「恰好一块」时短路：内容相同的块被复制成两份时要顺手清掉多余的。
    # 旧标记残留时不能短路：那说明页面还在引用 2.x 的脚本，必须走下面的剥除流程。
    if snippet in html and _count_blocks(html) == 1 and not _has_legacy_mark(html):
        report["already"] = True
        _drop_legacy_scripts(dist, html, report)
        return report

    _backup_index(index, html, report)
    html = _insert_snippet(_strip_injection(html), snippet)

    # 写前复核：官方升级是用 UpdateTransaction 整目录 rename 替换 dist 的，
    # 若刚好处在"读完未写回"的窗口，写回去的旧 index.html 会和新的 assets 对不上（白屏）。
    if not _same_stat(index, st0):
        report["error"] = "index.html changed during sync; skipped this round"
        return report

    def _still_same() -> bool:
        return _same_stat(index, st0)

    try:
        # verify 在 os.replace 前一刻执行：建 tmp + 写文件 + fsync 的这段时间，
        # st0/st1 那次复核看不到，官方升级整目录 rename 落在里面就会被旧内容盖掉。
        if not _write_bytes(index, _encode_index(html, crlf), verify=_still_same):
            report["error"] = "index.html changed during sync; skipped this round"
            return report
        report["injected"] = True
    except OSError as exc:
        report["error"] = "write index.html failed: %s" % exc
    if report["injected"]:
        # 新文档里已没有旧块，旧脚本可以收了；上面的 already 分支同理。
        _drop_legacy_scripts(dist, html, report)
    return report


def remove(dist_dir: Optional[Path] = None) -> Dict[str, object]:
    """移除注入标签与脚本文件。

    与 sync() 互斥，理由见 _IO_LOCK。
    """
    with _IO_LOCK:
        return _remove(dist_dir)


def _index_references(index: Path) -> Optional[bool]:
    """index.html 是否还引用注入脚本（标记或 script 标签）。

    True=还引用，False=干净，None=读不出来（权限/编码问题），删脚本前必须区分：
    清理失败就删脚本，页面会永远 404 且插件已停用、没有守护来修。
    """
    try:
        html, _, _ = _load_index(index)
    except (OSError, ValueError):
        return None
    if _has_any_mark(html) or SCRIPT_NAME in html:
        return True
    return any(name in html for name in LEGACY_SCRIPT_NAMES)


def _remove(dist_dir: Optional[Path] = None) -> Dict[str, object]:
    """移除注入标签与脚本文件。"""
    dist = Path(dist_dir) if dist_dir is not None else find_dist_dir()
    report: Dict[str, object] = {
        "dist": str(dist) if dist else None,
        "index_cleaned": False,
        "script_removed": False,
        "error": None,
    }
    if dist is None or not dist.is_dir():
        report["error"] = "dist directory not found"
        return report

    index = dist / "index.html"
    html = None
    if index.is_file():
        try:
            html, st0, crlf = _load_index(index)
        except OSError as exc:
            report["error"] = "read index.html failed: %s" % exc
        except ValueError:
            report["error"] = "index.html is not valid UTF-8; refusing to modify it"
    # 读出来的文档换行已归一化成 \n，清完按原风格写回；没有标记的文件一个字节都不动
    if html is not None and _has_any_mark(html):
        cleaned = _strip_injection(html)
        if not _same_stat(index, st0):
            report["error"] = "index.html changed during remove; skipped"
        else:
            try:
                _write_bytes(index, _encode_index(cleaned, crlf))
                report["index_cleaned"] = True
            except OSError as exc:
                report["error"] = "clean index.html failed: %s" % exc

    # 旧版留下的脚本也一并清掉：改名之后它已无人引用，留着只会让下次排查多一个迷惑项。
    targets = [dist / SCRIPT_NAME] + [dist / name for name in LEGACY_SCRIPT_NAMES]
    # index.html 只读一次：UNC 共享上每读一次都是一次网络往返，而这里最多要查两份脚本
    refs = _index_references(index) if index.is_file() else False
    unreadable = False
    still_referenced = []
    for target in targets:
        if not target.is_file():
            continue
        if refs is None:
            # 读不出 index 就不知道有没有人在用这份脚本，宁可留着（无害冗余）
            unreadable = True
        elif refs:
            still_referenced.append(target.name)
        else:
            try:
                target.unlink()
                report["script_removed"] = True
            except OSError as exc:
                report["error"] = "remove script failed: %s" % exc
    # 汇总而不是一路覆盖：新旧脚本可能一个删掉、一个因为还被引用而保留，
    # 只报最后一份的决定会让报告和磁盘实际状态对不上。
    if unreadable and not still_referenced:
        report["script_kept"] = "index.html unreadable; script kept"
    elif still_referenced:
        report["script_kept"] = "index.html still references %s" % ", ".join(still_referenced)

    # 写入中途失败或进程被杀可能留下临时文件（名字带 pid + uuid）。
    # 只清本进程的：别的进程可能正写着它自己那一份。
    _clean_stale_tmp(index)
    for target in targets:
        _clean_stale_tmp(target)
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="injector.py",
        description="把「不感兴趣」前端脚本注入 KiraAI WebUI 产物目录（data/dist）。",
    )
    parser.add_argument("--dist", type=Path, default=None, help="手动指定 dist 目录")
    parser.add_argument("--remove", "-r", action="store_true", help="移除注入（恢复原状）")
    parser.add_argument("--store", action="store_true", help="按 manifest.json 重新生成 store.json（插件商店源）")
    args = parser.parse_args(argv)

    if args.store:
        if args.remove or args.dist is not None:
            parser.error("--store 不能和 --dist / --remove 一起用")
        try:
            path, data = write_store()
        except (OSError, ValueError) as exc:
            print(json.dumps({"error": "write store.json failed: %s" % exc}, ensure_ascii=False))
            return 1
        print(json.dumps({"store": str(path), "plugins": list(data["plugins"])}, ensure_ascii=False, indent=2))
        return 0

    started = time.time()
    report = remove(args.dist) if args.remove else sync(args.dist)
    report["action"] = "remove" if args.remove else "sync"
    report["elapsed_ms"] = int((time.time() - started) * 1000)
    try:
        sys.stdout.reconfigure(errors="replace")  # 非 UTF-8 控制台不要把 report 打成 traceback
    except Exception:
        pass
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report.get("version_mismatch"):
        print(
            "warning: script version %s != manifest version %s (?v= 只会跟着脚本走)"
            % (
                report["version_mismatch"]["script"],
                report["version_mismatch"]["manifest"],
            ),
            file=sys.stderr,
        )
    return 1 if report.get("error") else 0


if __name__ == "__main__":
    raise SystemExit(main())
