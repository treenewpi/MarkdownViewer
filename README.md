# Markdown Viewer（macOS App）

原生 Swift + WKWebView 的离线 Markdown 阅读器，双击 `.md` 直接打开。
渲染链路与 Antigravity IDE / VS Code 对齐：`markdown-it` + `highlight.js` + `Mermaid` + `KaTeX` + GitHub Alerts + 官方 `markdown.css` / `highlight.css`。

## 主要特性

- **本地图片与媒体完整支持**：通过原生 `WKURLSchemeHandler`（`mdlocal://`）支持相对路径（`./img.png`、`../assets/a.svg`）、绝对路径、中文/空格路径、`file://` URL 及 HTML `<img>` / `<video>` 标签，导出 HTML 时自动内联为 Base64 Data URI。
- **Mermaid 图表离线渲染**：支持 `flowchart`、`sequenceDiagram`、`classDiagram`、`stateDiagram`、`erDiagram` 等，自动跟随深/浅色主题。
- **KaTeX 数学公式**：离线内联字体，支持行内公式 `$...$` / `\(...\)` 与块级公式 `$$...$$` / `\[...\]`。
- **与 Antigravity 样式对齐**：完整注入 `.vscode-light` / `.vscode-dark` 类名与 VS Code CSS 变量，支持 GitHub Alerts（`[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]`）。
- **视图模式与原生交互**：支持「预览 / 分屏 / 编辑」切换（打开本地文件默认进入纯预览模式）；原生拦截拖拽以保留文件真实路径；外部链接用系统浏览器打开，本地 `.md` 链接直接跳转；支持 `⌘R` 刷新、`⌘O` 打开、`⌘S` 导出 HTML 及标准剪贴板快捷键。

## 构建与安装

重新构建 `.app`：

```bash
./build.sh
```

安装到 `/Applications/MarkdownViewer.app` 并注册为 `.md` 默认打开方式：

```bash
./install.sh
```

## 结构

```text
mdview-app/
├── main.swift            App 主体（窗口、WKWebView、mdlocal:// 本地资源协议、拖拽与导出桥）
├── setdefault.swift      把 .md 默认处理器指向本 App
├── build.sh              一键编译与签名 MarkdownViewer.app
├── install.sh            安装到 /Applications 并注册默认处理器
├── Info.plist            Bundle 配置与 Markdown UTType 声明
├── viewer/               自包含前端（index.html、app.js、离线 vendor 依赖）
└── icon.svg / icon-1024.png / MarkdownViewer.icns
```

## 说明

- 二进制为 **ad-hoc 签名**。拷到别的 Mac 首次打开需右键 →「打开」，或运行：
  `xattr -dr com.apple.quarantine /Applications/MarkdownViewer.app`。
- 若 `.md` 已被其他编辑器（VS Code、Antigravity）占用，可在 Finder 里右键 →「显示简介」→「打开方式」→ 选 Markdown Viewer →「全部更改」。
