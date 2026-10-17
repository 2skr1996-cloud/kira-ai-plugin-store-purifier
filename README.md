# 商店净化 · Store Purifier

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white" alt="powered by dsh" /></a>
</p>

给 KiraAI 的插件商店加一个「不感兴趣」按钮，把不想再看到的插件收进独立标签页。

> **本项目的全部代码——浏览器脚本、Python 注入器和这份文档——都由 AI 生成**（DeepSeek），人类只负责提出需求、确认交互和验收结果。

## 功能

- 商店每张卡片的按钮行左侧多一个 **不感兴趣**（已安装的插件不显示）：点一下卡片消失、本页剩余卡片往上顶；不从下一页借卡，空位等官方下次刷新重排。
- 标签栏「插件商店」右侧多一个 **不感兴趣插件** 页，每页 12 张，可查看详情、取消标记、直接安装。
- 取消后若该插件已被响应过滤剔出当前列表，要等官方下次拉取才回商店。
- 名单只存当前浏览器的 localStorage，不上传、不同步。

## 安装

把插件目录放进 KiraAI 的 `data/plugins/kira-ai-plugin-store-purifier/`，然后重启或在插件面板启用。加载时脚本会写进 `data/dist` 并注入 `index.html`，`serve_spa()` 每次请求读盘且禁缓存，立即生效、无需重启 KiraAI。

```bash
python injector.py                 # 同步脚本 + 注入
python injector.py --remove        # 移除，恢复原状
python injector.py --dist <dir>    # 指定 dist 目录
```

## 卸载

停用插件即可（`terminate()` 会移除注入并删掉脚本），也可 `python injector.py --remove`。名单留在浏览器（`kira.pluginStore.notInterested.v1`）。

## 工作原理

启动时把 `web/store-purifier.js` 同步进 `data/dist`，在 `</head>` 前注入带版本号的 `<script>`：

```html
<!-- store-purifier:start -->
<script src="/store-purifier.js?v=<版本>" defer></script>
<!-- store-purifier:end -->
```

之后每 15 秒兜底检查：官方升级用 dist.zip 整包覆盖 `data/dist`，覆盖后自动重新注入，`?v=` 保证不吃旧缓存。

写回 `index.html` 很保守——只认合法 UTF-8，否则拒绝并告警；CRLF 原样写回；写前复核 mtime/size，撞上官方的整目录替换就放弃这一轮（避免白屏）；临时文件 + 原子替换；磁盘操作全在线程池，网络盘不会卡住主进程。`sync` 后再 `--remove` 能逐字节还原。

界面全在脚本里：定位商店网格、给卡片补按钮、拦截 `/api/plugin-store/fetch` 响应剔掉已隐藏项、渲染自建页、复刻官方样式做详情弹窗。

## 已知限制

- 名单按浏览器保存，换浏览器或清缓存会丢。
- 依赖官方 DOM 结构与文案，官方大改版可能需要适配。
- 只对 `data/dist` 生效；换部署方式要改 `injector.find_dist_dir()`。

## License

[MIT](LICENSE) © 2026 sijun
