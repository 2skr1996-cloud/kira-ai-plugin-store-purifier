"""商店净化 · Store Purifier —— KiraAI 插件商店的「不感兴趣」。

前端行为全部由浏览器端的 web/store-purifier.js 实现：
  1. 插件商店每张卡片的「安装」按钮左侧加一个「不感兴趣」按钮
  2. 点击后卡片立刻消失，本页剩余卡片由 CSS grid 自动前移（不跨页补位，
     空出来的那一张等下次刷新时由官方重新排布补上）
  3. 标签栏「插件商店」右侧加一个「不感兴趣插件」页，集中展示被隐藏的卡片
  4. 该页卡片显示「取消不感兴趣」，点击后恢复并回到商店

本插件只做一件事：把脚本送进 WebUI 产物目录（data/dist）并保持注入有效。
index.html 由 serve_spa() 每次请求读盘且禁缓存，所以注入当场生效、无需重启；
官方升级整包覆盖 dist 后，守护轮询会在 15 秒内自动重新注入。
"""

from __future__ import annotations

import asyncio
from typing import Optional

from core.plugin import BasePlugin, logger

from . import injector

CHECK_INTERVAL = 15.0


def _summary(report: dict) -> str:
    """把 sync/remove 的 report 压成一行人话。"""
    if report.get("error"):
        return "error=%s" % report.get("error")
    # remove 的 report 没有 script_written/injected，硬套 sync 的模板会打出
    # 「脚本无需更新, index.html已是最新」——实际刚删了脚本、清了块，纯误导。
    if "index_cleaned" in report or "script_removed" in report or "script_kept" in report:
        script = "脚本已删除" if report.get("script_removed") else (
            "脚本保留(%s)" % report["script_kept"] if report.get("script_kept") else "无脚本"
        )
        return "dist=%s, %s, %s" % (
            report.get("dist"),
            "index.html已清理" if report.get("index_cleaned") else "index.html无需清理",
            script,
        )
    return "dist=%s, 脚本%s, index.html%s" % (
        report.get("dist"),
        "已更新" if report.get("script_written") else "无需更新",
        "已写入" if report.get("injected") else "已是最新",
    )


class StorePurifierPlugin(BasePlugin):

    def __init__(self, ctx, cfg: dict):
        super().__init__(ctx, cfg)
        self._task: Optional[asyncio.Task] = None
        # 上一次的错误内容：错误变了才告警，恢复了要主动说一声（否则长期静默）
        self._last_error: Optional[str] = None
        self._last_backup_error: Optional[str] = None
        self._warned_mismatch = False

    def _announce(self, report: dict, stage: str, first: bool = False) -> None:
        """按「错误是否变化」打日志：首次失败告警，持续失败不刷屏，恢复要报喜。"""
        mismatch = report.get("version_mismatch")
        if mismatch:
            if not self._warned_mismatch:
                self._warned_mismatch = True
                logger.warning(
                    "[store-purifier] 脚本版本 %s 与 manifest 版本 %s 不一致，?v= 只会跟着脚本走"
                    % (mismatch.get("script"), mismatch.get("manifest"))
                )
        else:
            # 版本修好后要复位，否则同一个进程里再次写歪就再也不会告警
            self._warned_mismatch = False
        backup_error = report.get("backup_error")
        if backup_error and backup_error != self._last_backup_error:
            self._last_backup_error = backup_error
            logger.warning("[store-purifier] 备份 index.html 失败: %s" % backup_error)
        elif not backup_error:
            self._last_backup_error = None
        error = report.get("error")
        if error:
            if error != self._last_error:
                self._last_error = error
                logger.warning("[store-purifier] %s失败: %s" % (stage, error))
            return
        if self._last_error is not None:
            self._last_error = None
            logger.info("[store-purifier] %s恢复正常 (%s)" % (stage, _summary(report)))
        elif first:
            logger.info("[store-purifier] WebUI 注入就绪 (%s)" % _summary(report))
        elif report.get("injected") or report.get("script_written"):
            logger.info("[store-purifier] 检测到 dist 被覆盖，已重新注入 (%s)" % _summary(report))

    async def _sync(self) -> dict:
        """跑一次同步，异常转成 report 交给 _announce 判定；取消必须原样抛出，
        否则 terminate() 里的 task.cancel() 会被吞掉。

        sync 会读盘 / 写盘，dist 是 UNC 共享时一次 SMB 超时能卡几十秒，
        放在事件循环线程里会连带着把整个 KiraAI 冻住 —— 一律丢到线程池执行。
        """
        try:
            return await asyncio.to_thread(injector.sync)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return {"error": "sync raised: %s" % exc}

    async def initialize(self):
        # 注入失败绝不能拖垮插件加载：守护轮询还会继续重试。
        self._announce(await self._sync(), "WebUI 注入", first=True)
        self._task = asyncio.create_task(self._guard_loop(), name="store-purifier-guard")

    async def _guard_loop(self):
        """官方升级（整包覆盖 dist）后自动重新注入。"""
        while True:
            await asyncio.sleep(CHECK_INTERVAL)
            self._announce(await self._sync(), "守护同步")

    async def terminate(self):
        if self._task is not None:
            task, self._task = self._task, None
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logger.warning("[store-purifier] 守护任务退出异常: %s" % exc)
        try:
            # 同样不能在事件循环里做 UNC 磁盘操作
            report = await asyncio.to_thread(injector.remove)
            if report.get("error"):
                logger.warning("[store-purifier] 移除 WebUI 注入未完全成功: %s" % report)
            else:
                logger.info("[store-purifier] 已移除 WebUI 注入 (%s)" % _summary(report))
        except Exception as exc:
            logger.warning("[store-purifier] 移除 WebUI 注入失败: %s" % exc)
