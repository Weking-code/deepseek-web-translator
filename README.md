# DeepSeek 网页翻译 · Edge 扩展

在 Microsoft Edge 中用自己的 DeepSeek API Key 逐段翻译网页、查词，并整理论文笔记。扩展支持中英对照和仅译文显示，笔记可导出为 Markdown。

[下载 v1.3.1 安装包](https://github.com/Weking-code/deepseek-web-translator/raw/refs/heads/main/downloads/deepseek-web-translator-1.3.1.zip) · [完整使用说明](docs/usage.md)

## 能做什么

| 功能 | 怎么用 |
| --- | --- |
| 整页对照翻译 | 点网页右侧「译」或按 `Alt+T`。再按一次可还原网页。相同文本的译文可从本地缓存读取。 |
| 划词翻译 | 选中文字后点「译」气泡，或使用右键菜单。 |
| 查词与粘贴翻译 | 点右侧「文」。支持查词、翻译句子及复制结果。 |
| 文献整理 | 点右侧「摘」，对页面提取到的论文正文生成摘要。可编辑小节、添加笔记和截图，再导出为 Markdown。 |

## 安装与首次设置

1. 下载 ZIP 并解压到固定位置。打开 `edge://extensions/`，启用「开发人员模式」。
2. 点「加载解压缩的扩展」，选择直接包含 `manifest.json` 的解压文件夹。也可以直接加载仓库根目录。
3. 在扩展设置中填写自己的 DeepSeek API Key。将「模型」手动设为 **`deepseek-flash`**，再依次点「测试连接」和「保存」。刷新要翻译的网页即可使用。[Microsoft Edge 侧载说明](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)

v1.3.1 界面预填的是 `deepseek-chat`。DeepSeek 已停用该模型名，请在首次设置和恢复默认以后重新填写模型。[DeepSeek API 文档](https://api-docs.deepseek.com/en/) · [停用公告](https://api-docs.deepseek.com/news/news260424/)

## 数据与费用

扩展把执行任务所需的网页文本发往设置中的 API 地址，默认是 `https://api.deepseek.com`。请求带上用户提供的认证 Key。设置、译文缓存和笔记草稿保存在浏览器本地，使用「保存为 .md」时可导出到选定的目录。实际 API 费用取决于所用模型、token 用量及缓存命中情况。[DeepSeek 计价](https://api-docs.deepseek.com/quick_start/pricing/)

## 源码与验证

- `manifest.json`、`src/` 和 `icons/` 构成可直接侧载的扩展。
- `docs/usage.md` 包含操作速查、设置、常见问题和版本记录。
- `tools/test_cache.mjs` 可用 `node tools/test_cache.mjs` 运行缓存测试，使用模拟请求。其余 API 测试脚本会发出实际请求。
