/* Standalone Markdown viewer (Antigravity / VS Code aligned).
 * Pipeline:
 *   markdown-it + highlight.js + mermaid + katex + GFM alerts + VS Code markdown.css / highlight.css
 */
(function () {
  'use strict';

  var STORAGE_CONTENT = 'mdview.content';
  var STORAGE_THEME = 'mdview.theme';
  var STORAGE_OPTS = 'mdview.opts';
  var STORAGE_MODE = 'mdview.mode';
  var STORAGE_WIDE = 'mdview.wide';

  var isNativeApp = Boolean(
    window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native
  );

  var DEFAULT_TEXT = [
    '# Markdown Viewer',
    '',
    '与 **Antigravity IDE** 对齐的离线 Markdown 阅读器。',
    '',
    '- 渲染器：`markdown-it` + `highlight.js`',
    '- 图表：`Mermaid`（离线 SVG 渲染，随深浅色主题切换）',
    '- 公式：`KaTeX`（支持行内与块级公式）',
    '- 图片：支持相对路径、绝对路径、`file://` 与网络图片',
    '- 提示框：支持 GitHub Alerts（`NOTE` / `TIP` / `IMPORTANT` / `WARNING` / `CAUTION`）',
    '',
    '> [!TIP]',
    '> 双击 `.md` 文件、拖拽文件到窗口或使用 `⌘O` 打开本地文档，所有相对路径图片与 Mermaid 图表都会自动渲染。',
    '',
    '## Mermaid 图表示例',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Markdown 文件] --> B[markdown-it 解析]',
    '  B --> C[highlight.js 高亮]',
    '  B --> D[Mermaid SVG 图表]',
    '  B --> E[KaTeX 数学公式]',
    '  B --> F[mdlocal:// 本地图片]',
    '```',
    '',
    '## 数学公式',
    '',
    '行内公式：$E = mc^2$，欧拉恒等式 $e^{i\\pi} + 1 = 0$。',
    '',
    '$$',
    '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
    '$$',
    '',
    '## 代码与表格',
    '',
    '```js',
    'const md = markdownit({ html: true, linkify: true });',
    'console.log(md.render("# hello"));',
    '```',
    '',
    '| 功能 | 状态 |',
    '| --- | --- |',
    '| 本地图片加载 | 已支持 |',
    '| Mermaid 图表 | 已支持 |',
    '| KaTeX 数学公式 | 已支持 |',
    '| GitHub Alerts | 已支持 |',
    ''
  ].join('\n');

  var opts = load(STORAGE_OPTS, { breaks: false, typographer: false, linkify: true });
  var currentFilePath = null;
  var currentBaseDir = null;
  var userChoseMode = false;
  var renderSeq = 0;
  var mermaidCounter = 0;

  // ---- Utilities -----------------------------------------------------------
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeDecodeURIComponent(str) {
    try { return decodeURIComponent(str); } catch (e) { return str; }
  }

  function normalizePosixPath(p) {
    var parts = p.replace(/\\/g, '/').split('/');
    var stack = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(seg);
      }
    }
    return '/' + stack.join('/');
  }

  function resolveAbsoluteLocalPath(rawUrl) {
    if (!rawUrl) return null;
    var trimmed = String(rawUrl).trim();
    if (!trimmed) return null;

    // Leave remote, data, blob, anchor, javascript, mailto URLs untouched
    if (/^(https?:|data:|blob:|mailto:|javascript:|mdlocal:|#)/i.test(trimmed)) {
      return null;
    }

    var suffix = '';
    var pathPart = trimmed;
    var hashIdx = pathPart.indexOf('#');
    if (hashIdx >= 0) {
      suffix = pathPart.slice(hashIdx);
      pathPart = pathPart.slice(0, hashIdx);
    }
    var queryIdx = pathPart.indexOf('?');
    if (queryIdx >= 0) {
      suffix = pathPart.slice(queryIdx) + suffix;
      pathPart = pathPart.slice(0, queryIdx);
    }
    if (!pathPart) return null;

    var absPath = null;
    if (/^file:\/\//i.test(pathPart)) {
      var stripped = pathPart.replace(/^file:\/\/localhost/i, '').replace(/^file:\/\//i, '');
      absPath = normalizePosixPath(safeDecodeURIComponent(stripped));
    } else if (pathPart.charAt(0) === '/') {
      absPath = normalizePosixPath(safeDecodeURIComponent(pathPart));
    } else if (currentBaseDir) {
      var decoded = safeDecodeURIComponent(pathPart);
      absPath = normalizePosixPath(currentBaseDir + '/' + decoded);
    }

    if (!absPath) return null;
    return { absPath: absPath, suffix: suffix };
  }

  function toLocalResourceUrl(rawUrl) {
    if (!isNativeApp) return rawUrl;
    var resolved = resolveAbsoluteLocalPath(rawUrl);
    if (!resolved) return rawUrl;
    var encoded = resolved.absPath
      .split('/')
      .map(function (seg) { return encodeURIComponent(seg); })
      .join('/');
    return 'mdlocal://local' + encoded + resolved.suffix;
  }

  // ---- KaTeX math preprocessor --------------------------------------------
  function extractMath(src) {
    if (!window.katex) return { text: src, tokens: [] };

    var tokens = [];
    function pushMath(expr, displayMode) {
      var id = tokens.length;
      var html;
      try {
        html = window.katex.renderToString(expr.trim(), {
          displayMode: displayMode,
          throwOnError: false,
          strict: 'ignore'
        });
      } catch (e) {
        html = '<code class="katex-error">' + escapeHtml(expr) + '</code>';
      }
      var placeholder = '@@MDVIEW_MATH_' + id + '@@';
      tokens.push({ placeholder: placeholder, html: html, displayMode: displayMode });
      return displayMode ? '\n\n' + placeholder + '\n\n' : placeholder;
    }

    // Protect fenced code blocks and inline code spans first
    var codeHolders = [];
    var protectedText = src.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g, function (m) {
      var idx = codeHolders.length;
      codeHolders.push(m);
      return '\n@@MDVIEW_CODE_' + idx + '@@\n';
    });
    protectedText = protectedText.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, function (m) {
      var idx = codeHolders.length;
      codeHolders.push(m);
      return '@@MDVIEW_CODE_' + idx + '@@';
    });

    // Block math: $$ ... $$
    protectedText = protectedText.replace(/(^|[^\\])\$\$([\s\S]+?)\$\$/g, function (m, pre, expr) {
      if (!expr.trim()) return m;
      return pre + pushMath(expr, true);
    });

    // Block math: \[ ... \]
    protectedText = protectedText.replace(/(^|[^\\])\\\[([\s\S]+?)\\\]/g, function (m, pre, expr) {
      if (!expr.trim()) return m;
      return pre + pushMath(expr, true);
    });

    // Inline math: \( ... \)
    protectedText = protectedText.replace(/(^|[^\\])\\\((.+?)\\\)/g, function (m, pre, expr) {
      if (!expr.trim()) return m;
      return pre + pushMath(expr, false);
    });

    // Inline math: $ ... $ (avoid matching currency like $100 ... $200; no regex lookbehind for Safari 15 / macOS 12 compat)
    protectedText = protectedText.replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)\$(?!\d)/g, function (m, pre, expr) {
      if (/\s$/.test(expr) || /^\d+(?:[.,]\d+)?$/.test(expr.trim())) return m;
      return pre + pushMath(expr, false);
    });

    // Restore code placeholders
    protectedText = protectedText.replace(/@@MDVIEW_CODE_(\d+)@@/g, function (_, idx) {
      return codeHolders[Number(idx)];
    });

    return { text: protectedText, tokens: tokens };
  }

  function restoreMath(html, tokens) {
    if (!tokens.length) return html;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.displayMode) {
        html = html.replace('<p>' + t.placeholder + '</p>', '<div class="katex-display-wrap">' + t.html + '</div>');
      }
      html = html.replace(t.placeholder, t.html);
    }
    return html;
  }

  // ---- markdown-it configuration ------------------------------------------
  var md = window.markdownit({
    html: true,
    linkify: opts.linkify,
    breaks: opts.breaks,
    typographer: opts.typographer,
    highlight: function (str, lang) {
      if (lang && window.hljs && window.hljs.getLanguage(lang)) {
        try {
          return window.hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        } catch (e) { /* fall through */ }
      }
      return md.utils.escapeHtml(str);
    }
  });

  // Allow file:// and mdlocal:// URLs just like Antigravity / VS Code
  var defaultValidateLink = md.validateLink.bind(md);
  md.validateLink = function (url) {
    var str = String(url || '').trim();
    if (/^(file:|mdlocal:)/i.test(str)) return true;
    return defaultValidateLink(str);
  };

  // Encode unescaped spaces in Markdown image destinations like ![alt](./my folder/a b.png)
  function normalizeImageSpaces(src) {
    var codeHolders = [];
    var text = src.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[ \t]*(?=\n|$)/g, function (m) {
      var idx = codeHolders.length;
      codeHolders.push(m);
      return '\n@@MDVIEW_IMG_CODE_' + idx + '@@\n';
    });
    text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, function (m) {
      var idx = codeHolders.length;
      codeHolders.push(m);
      return '@@MDVIEW_IMG_CODE_' + idx + '@@';
    });

    text = text.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, function (m, alt, dest) {
      var trimmed = dest.trim();
      if (!trimmed || trimmed.charAt(0) === '<' || trimmed.indexOf(' ') < 0) return m;
      // Preserve optional title at the end: ![alt](path with space "title")
      var titleMatch = trimmed.match(/^(.+?)\s+("[^"]*"|'[^']*')$/);
      if (titleMatch) {
        return '![' + alt + '](<' + titleMatch[1].trim() + '> ' + titleMatch[2] + ')';
      }
      return '![' + alt + '](<' + trimmed + '>)';
    });

    return text.replace(/@@MDVIEW_IMG_CODE_(\d+)@@/g, function (_, idx) {
      return codeHolders[Number(idx)];
    });
  }

  // Intercept mermaid fenced blocks
  var defaultFence = md.renderer.rules.fence || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    var token = tokens[idx];
    var info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
    var lang = info.split(/\s+/g)[0].toLowerCase();
    if (lang === 'mermaid') {
      var encoded = escapeHtml(token.content.trim());
      return '<div class="mermaid-block" data-mermaid="' + encoded + '"><div class="mermaid-status">Rendering diagram…</div></div>\n';
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  // Rewrite markdown image URLs for local files
  var defaultImage = md.renderer.rules.image || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.image = function (tokens, idx, options, env, self) {
    var token = tokens[idx];
    var srcIdx = token.attrIndex('src');
    if (srcIdx >= 0) {
      var orig = token.attrs[srcIdx][1];
      token.attrSet('data-orig-src', orig);
      token.attrs[srcIdx][1] = toLocalResourceUrl(orig);
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  // Add slug ids to headings for anchor navigation
  function slugify(s) {
    return String(s)
      .toLowerCase()
      .trim()
      .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
      .replace(/\s+/g, '-');
  }
  var defaultHeadingOpen = md.renderer.rules.heading_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
    var next = tokens[idx + 1];
    if (next && next.type === 'inline' && next.content) {
      tokens[idx].attrSet('id', slugify(next.content));
    }
    return defaultHeadingOpen(tokens, idx, options, env, self);
  };

  // ---- Post-processors: Task lists & GitHub Alerts ------------------------
  function taskLists(html) {
    return html.replace(/<li>(\s*)(?:<p>)?\[([ xX])\]\s/g, function (match, pad, mark) {
      var checked = mark.toLowerCase() === 'x' ? ' checked' : '';
      var hasP = match.indexOf('<p>') >= 0;
      return '<li class="task-list-item">' + (hasP ? '<p>' : '') + '<input type="checkbox" disabled' + checked + '> ';
    });
  }

  var ALERT_META = {
    NOTE:      { title: 'Note',      cls: 'note',      icon: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>' },
    TIP:       { title: 'Tip',       cls: 'tip',       icon: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"></path></svg>' },
    IMPORTANT: { title: 'Important', cls: 'important', icon: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>' },
    WARNING:   { title: 'Warning',   cls: 'warning',   icon: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>' },
    CAUTION:   { title: 'Caution',   cls: 'caution',   icon: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>' }
  };

  function transformAlerts(container) {
    var quotes = container.querySelectorAll('blockquote');
    for (var i = 0; i < quotes.length; i++) {
      var bq = quotes[i];
      var firstP = bq.querySelector(':scope > p:first-child');
      if (!firstP) continue;
      var m = firstP.innerHTML.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*<br\s*\/?>|\s*\n|\s|$)/i);
      if (!m) continue;
      var key = m[1].toUpperCase();
      var meta = ALERT_META[key];
      if (!meta) continue;
      firstP.innerHTML = firstP.innerHTML.slice(m[0].length);
      if (!firstP.innerHTML.trim()) firstP.remove();

      var div = document.createElement('div');
      div.className = 'markdown-alert markdown-alert-' + meta.cls;
      var title = document.createElement('p');
      title.className = 'markdown-alert-title';
      title.innerHTML = meta.icon + '<span>' + meta.title + '</span>';
      div.appendChild(title);
      while (bq.firstChild) {
        div.appendChild(bq.firstChild);
      }
      bq.parentNode.replaceChild(div, bq);
    }
  }

  function rewriteHtmlMediaElements(container) {
    if (!isNativeApp) return;
    var els = container.querySelectorAll('img[src], video[src], audio[src], source[src]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var curSrc = el.getAttribute('src');
      if (!curSrc || /^mdlocal:/i.test(curSrc)) continue;
      if (!el.getAttribute('data-orig-src')) {
        el.setAttribute('data-orig-src', curSrc);
      }
      var rewritten = toLocalResourceUrl(curSrc);
      if (rewritten !== curSrc) {
        el.setAttribute('src', rewritten);
      }
    }
  }

  function attachImageFallbacks(container) {
    var imgs = container.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        img.addEventListener('error', function () {
          if (img.dataset.fallbackApplied) return;
          img.dataset.fallbackApplied = '1';
          var orig = img.getAttribute('data-orig-src') || img.getAttribute('src') || '';
          var alt = img.getAttribute('alt') || '图片加载失败';
          var box = document.createElement('span');
          box.className = 'md-img-error';
          box.textContent = '⚠ ' + alt + (orig ? ' (' + orig + ')' : '');
          img.replaceWith(box);
        });
      })(imgs[i]);
    }
  }

  function renderHtml(text) {
    var normalized = normalizeImageSpaces(text);
    var math = extractMath(normalized);
    var html = taskLists(md.render(math.text));
    return restoreMath(html, math.tokens);
  }

  // ---- Styles (VS Code / Antigravity aligned) -----------------------------
  function scopedMarkdownCss(rawCss) {
    return rawCss
      .replace(/html,\s*body\s*\{/g, '.markdown-body {')
      .replace(/(^|\n)body\s*\{/g, '$1.markdown-body {')
      .replace(/body\./g, '.markdown-body.');
  }

  function buildThemeCss(theme, forExport) {
    var dark = theme === 'dark';
    var s = window.MD_STYLES || { markdown: '', highlight: '', katex: '' };
    var rootSel = forExport ? 'body' : '.markdown-body';
    var mdCss = forExport ? s.markdown : scopedMarkdownCss(s.markdown);

    var extra = [
      ':root {',
      '  --vscode-editor-background: ' + (dark ? '#1e1e1e' : '#ffffff') + ';',
      '  --vscode-editor-foreground: ' + (dark ? '#d4d4d4' : '#1f1f1f') + ';',
      '  --vscode-text: ' + (dark ? '#d4d4d4' : '#1f1f1f') + ';',
      '  --vscode-textLink-foreground: ' + (dark ? '#4daafc' : '#0b57d0') + ';',
      '  --vscode-textLink-activeForeground: ' + (dark ? '#79c0ff' : '#0842a0') + ';',
      '  --vscode-textCodeBlock-background: ' + (dark ? 'rgba(10, 10, 10, 0.45)' : 'rgba(220, 220, 220, 0.4)') + ';',
      '  --vscode-textPreformat-foreground: ' + (dark ? '#d7ba7d' : '#a31515') + ';',
      '  --vscode-textPreformat-background: ' + (dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)') + ';',
      '  --vscode-textBlockQuote-background: ' + (dark ? 'rgba(127, 127, 127, 0.12)' : 'rgba(127, 127, 127, 0.1)') + ';',
      '  --vscode-textBlockQuote-border: rgba(0, 122, 204, 0.55);',
      '  --vscode-widget-border: ' + (dark ? '#3c3c3c' : '#d8d8d8') + ';',
      '  --vscode-editor-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;',
      '  --markdown-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;',
      '  --markdown-font-size: 15px;',
      '  --markdown-line-height: 1.65;',
      '}',
      rootSel + ' { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }',
      rootSel + ' a { color: var(--vscode-textLink-foreground); }',
      rootSel + ' a:hover { color: var(--vscode-textLink-activeForeground); }',
      rootSel + ' :not(pre) > code {',
      '  color: var(--vscode-textPreformat-foreground);',
      '  background-color: var(--vscode-textPreformat-background);',
      '  padding: 0.12em 0.35em;',
      '  border-radius: 4px;',
      '  font-size: 0.9em;',
      '}',
      rootSel + ' pre {',
      '  padding: 14px 16px;',
      '  border-radius: 6px;',
      '  overflow: auto;',
      '  margin-bottom: 16px;',
      '}',
      rootSel + ' pre code { padding: 0; background: none; font-size: 0.9em; display: block; }',
      rootSel + ' blockquote {',
      '  background: var(--vscode-textBlockQuote-background);',
      '  border-left-color: var(--vscode-textBlockQuote-border);',
      '  padding: 8px 16px 8px 12px;',
      '  margin: 0 0 16px 0;',
      '}',
      rootSel + ' blockquote > :last-child { margin-bottom: 0; }',
      rootSel + ' li.task-list-item { list-style: none; margin-left: -1.4em; }',
      rootSel + ' li.task-list-item input { margin-right: 0.45em; vertical-align: middle; }',
      rootSel + ' img { max-width: 100%; height: auto; border-radius: 4px; }',
      rootSel + ' table { display: block; width: max-content; max-width: 100%; overflow: auto; }',
      rootSel + ' .mermaid-block {',
      '  margin: 16px 0;',
      '  padding: 16px;',
      '  border-radius: 6px;',
      '  border: 1px solid var(--vscode-widget-border);',
      '  background: ' + (dark ? '#252526' : '#fafafa') + ';',
      '  text-align: center;',
      '  overflow-x: auto;',
      '}',
      rootSel + ' .mermaid-block svg { max-width: 100%; height: auto; }',
      rootSel + ' .mermaid-status { color: ' + (dark ? '#9d9d9d' : '#6b6b6b') + '; font-size: 13px; }',
      rootSel + ' .mermaid-error {',
      '  text-align: left;',
      '  color: ' + (dark ? '#f48771' : '#b42318') + ';',
      '  font-size: 13px;',
      '}',
      rootSel + ' .mermaid-error pre { margin-top: 8px; font-size: 12px; }',
      rootSel + ' .md-img-error {',
      '  display: inline-block;',
      '  padding: 6px 10px;',
      '  border-radius: 4px;',
      '  font-size: 13px;',
      '  border: 1px dashed ' + (dark ? '#6e4c4c' : '#d97777') + ';',
      '  background: ' + (dark ? 'rgba(244, 135, 113, 0.1)' : 'rgba(180, 35, 24, 0.06)') + ';',
      '  color: ' + (dark ? '#f48771' : '#b42318') + ';',
      '}',
      rootSel + ' .katex-display-wrap { overflow-x: auto; overflow-y: hidden; margin: 14px 0; }',
      /* GitHub Alerts */
      rootSel + ' .markdown-alert {',
      '  padding: 10px 16px;',
      '  margin: 0 0 16px 0;',
      '  border-left: 4px solid;',
      '  border-radius: 4px;',
      '  background: ' + (dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)') + ';',
      '}',
      rootSel + ' .markdown-alert > :last-child { margin-bottom: 0; }',
      rootSel + ' .markdown-alert-title {',
      '  display: flex; align-items: center; gap: 8px;',
      '  font-weight: 600; margin: 0 0 6px 0;',
      '}',
      rootSel + ' .markdown-alert-note { border-left-color: ' + (dark ? '#4493f8' : '#0969da') + '; }',
      rootSel + ' .markdown-alert-note .markdown-alert-title { color: ' + (dark ? '#4493f8' : '#0969da') + '; }',
      rootSel + ' .markdown-alert-tip { border-left-color: ' + (dark ? '#3fb950' : '#1a7f37') + '; }',
      rootSel + ' .markdown-alert-tip .markdown-alert-title { color: ' + (dark ? '#3fb950' : '#1a7f37') + '; }',
      rootSel + ' .markdown-alert-important { border-left-color: ' + (dark ? '#ab7df8' : '#8250df') + '; }',
      rootSel + ' .markdown-alert-important .markdown-alert-title { color: ' + (dark ? '#ab7df8' : '#8250df') + '; }',
      rootSel + ' .markdown-alert-warning { border-left-color: ' + (dark ? '#d29922' : '#9a6700') + '; }',
      rootSel + ' .markdown-alert-warning .markdown-alert-title { color: ' + (dark ? '#d29922' : '#9a6700') + '; }',
      rootSel + ' .markdown-alert-caution { border-left-color: ' + (dark ? '#f85149' : '#cf222e') + '; }',
      rootSel + ' .markdown-alert-caution .markdown-alert-title { color: ' + (dark ? '#f85149' : '#cf222e') + '; }'
    ].join('\n');

    return mdCss + '\n' + s.highlight + '\n' + (s.katex || '') + '\n' + extra;
  }

  // ---- Mermaid rendering --------------------------------------------------
  async function renderMermaidBlocks(container, seq) {
    if (!window.mermaid) return;
    var blocks = container.querySelectorAll('.mermaid-block[data-mermaid]');
    if (!blocks.length) return;

    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'dark' ? 'dark' : 'default',
        securityLevel: 'loose',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", sans-serif'
      });
    } catch (e) {}

    for (var i = 0; i < blocks.length; i++) {
      if (seq !== renderSeq) return;
      var block = blocks[i];
      var code = block.getAttribute('data-mermaid') || '';
      var id = 'mmd-' + (++mermaidCounter);
      try {
        var result = await window.mermaid.render(id, code);
        if (seq !== renderSeq) return;
        block.innerHTML = result.svg;
        if (typeof result.bindFunctions === 'function') {
          result.bindFunctions(block);
        }
      } catch (err) {
        if (seq !== renderSeq) return;
        var orphan = document.getElementById('d' + id);
        if (orphan) orphan.remove();
        block.innerHTML =
          '<div class="mermaid-error"><strong>Mermaid 渲染失败：</strong>' +
          escapeHtml(err && err.message ? err.message : String(err)) +
          '<pre><code>' + escapeHtml(code) + '</code></pre></div>';
      }
    }
  }

  // ---- DOM & state --------------------------------------------------------
  var src = document.getElementById('src');
  var preview = document.getElementById('preview');
  var previewScroll = document.getElementById('preview-scroll');
  var dynamicStyle = document.getElementById('md-dynamic-style');
  var fileInput = document.getElementById('file');
  var docTitle = document.getElementById('doc-title');

  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var theme = load(STORAGE_THEME, prefersDark ? 'dark' : 'light');
  var mode = load(STORAGE_MODE, 'split');
  var wide = Boolean(load(STORAGE_WIDE, false));
  var wideBtn = document.getElementById('wide');
  var fullscreenBtn = document.getElementById('fullscreen');

  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    document.getElementById('theme').textContent = theme === 'dark' ? '浅色' : '深色';
    preview.classList.remove('vscode-light', 'vscode-dark');
    preview.classList.add(theme === 'dark' ? 'vscode-dark' : 'vscode-light');
    dynamicStyle.textContent = buildThemeCss(theme, false);
    save(STORAGE_THEME, theme);
  }

  function applyMode(newMode, persist) {
    mode = newMode;
    document.body.dataset.mode = mode;
    var btns = document.querySelectorAll('.seg-group button[data-mode]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].dataset.mode === mode);
    }
    if (persist) save(STORAGE_MODE, mode);
  }

  function applyWide(on, persist) {
    wide = Boolean(on);
    document.body.dataset.wide = wide ? '1' : '0';
    if (wideBtn) {
      wideBtn.classList.toggle('active', wide);
      wideBtn.textContent = wide ? '标准宽' : '宽屏';
    }
    if (persist) save(STORAGE_WIDE, wide);
  }

  function applyFullScreenState(isFS) {
    if (fullscreenBtn) {
      fullscreenBtn.classList.toggle('active', Boolean(isFS));
      fullscreenBtn.textContent = isFS ? '退出全屏' : '全屏';
    }
  }

  var timer = null;
  var lastRendered = null;
  var lastBaseDir = null;

  function paint(force) {
    var text = src.value;
    if (!force && text === lastRendered && currentBaseDir === lastBaseDir) return;
    lastRendered = text;
    lastBaseDir = currentBaseDir;
    var seq = ++renderSeq;

    var prevScrollTop = previewScroll.scrollTop;
    preview.innerHTML = renderHtml(text);
    rewriteHtmlMediaElements(preview);
    transformAlerts(preview);
    attachImageFallbacks(preview);
    previewScroll.scrollTop = prevScrollTop;

    renderMermaidBlocks(preview, seq);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      paint(false);
      if (!currentFilePath) save(STORAGE_CONTENT, src.value);
    }, 150);
  }

  function setContent(text, meta) {
    if (meta && typeof meta === 'object') {
      currentFilePath = meta.filePath || null;
      currentBaseDir = meta.baseDir || null;
      if (meta.fileName) {
        docTitle.innerHTML = escapeHtml(meta.fileName) +
          '<small id="doc-subtitle">' + escapeHtml(meta.baseDir || '') + '</small>';
      }
    }
    src.value = text;
    lastRendered = null;
    paint(true);
    if (!currentFilePath) save(STORAGE_CONTENT, text);
  }

  function buildExportDocument() {
    var cls = theme === 'dark' ? 'vscode-dark' : 'vscode-light';
    var css = buildThemeCss(theme, true);
    var bodyHtml = preview.innerHTML;
    var title = (currentFilePath ? currentFilePath.split('/').pop() : 'Markdown Export');
    return '<!doctype html><html data-theme="' + theme + '"><head><meta charset="utf-8">' +
      '<title>' + escapeHtml(title) + '</title>' +
      '<style>' + css + '</style>' +
      '</head><body class="' + cls + '">' + bodyHtml + '</body></html>';
  }

  function readFileInBrowser(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      setContent(String(reader.result), { fileName: file.name, filePath: null, baseDir: null });
    };
    reader.readAsText(file);
  }

  // ---- Event listeners ----------------------------------------------------
  document.getElementById('open').addEventListener('click', function () {
    if (isNativeApp) {
      window.webkit.messageHandlers.native.postMessage({ type: 'openDialog' });
    } else {
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', function () {
    readFileInBrowser(fileInput.files[0]);
    fileInput.value = '';
  });

  document.getElementById('theme').addEventListener('click', function () {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    paint(true);
  });

  if (wideBtn) {
    wideBtn.addEventListener('click', function () {
      applyWide(!wide, true);
    });
  }

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', function () {
      if (isNativeApp) {
        window.webkit.messageHandlers.native.postMessage({ type: 'toggleFullScreen' });
      } else if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
      } else {
        document.exitFullscreen && document.exitFullscreen();
      }
    });
  }

  if (!isNativeApp) {
    document.addEventListener('fullscreenchange', function () {
      applyFullScreenState(Boolean(document.fullscreenElement));
    });
  }

  var modeButtons = document.querySelectorAll('.seg-group button[data-mode]');
  for (var i = 0; i < modeButtons.length; i++) {
    modeButtons[i].addEventListener('click', function (e) {
      userChoseMode = true;
      applyMode(e.currentTarget.dataset.mode, true);
    });
  }

  document.getElementById('export').addEventListener('click', function () {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.export) {
      window.webkit.messageHandlers.export.postMessage(buildExportDocument());
      return;
    }
    var doc = buildExportDocument();
    var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'markdown-export.html';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  // Intercept link clicks in preview
  preview.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href]');
    if (!link) return;
    var href = link.getAttribute('href');
    if (!href) return;

    if (href.charAt(0) === '#') {
      e.preventDefault();
      var targetId = safeDecodeURIComponent(href.slice(1));
      var target = document.getElementById(targetId) || document.getElementById(slugify(targetId));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (/^(https?:|mailto:)/i.test(href)) {
      if (isNativeApp) {
        e.preventDefault();
        window.webkit.messageHandlers.native.postMessage({ type: 'openExternal', url: href });
      }
      return;
    }

    if (isNativeApp) {
      var resolved = resolveAbsoluteLocalPath(href);
      if (resolved) {
        e.preventDefault();
        window.webkit.messageHandlers.native.postMessage({
          type: 'openLocalFile',
          path: resolved.absPath
        });
      }
    }
  });

  src.addEventListener('input', schedule);
  src.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      var start = src.selectionStart, end = src.selectionEnd;
      src.value = src.value.slice(0, start) + '  ' + src.value.slice(end);
      src.selectionStart = src.selectionEnd = start + 2;
      schedule();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      document.getElementById('export').click();
    }
  });

  // Drag & drop (browser fallback; native macOS app intercepts drag directly with real path)
  if (!isNativeApp) {
    ['dragenter', 'dragover'].forEach(function (t) {
      window.addEventListener(t, function (e) { e.preventDefault(); document.body.classList.add('dragging'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      window.addEventListener(t, function (e) {
        e.preventDefault();
        if (t === 'drop' || e.target === document.body) document.body.classList.remove('dragging');
      });
    });
    window.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFileInBrowser(f);
    });
  }

  applyTheme();
  applyMode(mode, false);
  applyWide(wide, false);
  setContent(load(STORAGE_CONTENT, DEFAULT_TEXT));
  setInterval(function () { if (!currentFilePath) save(STORAGE_CONTENT, src.value); }, 5000);

  // ---- Bridge for the native macOS app ------------------------------------
  window.__loadMarkdown = function (text, meta) {
    if (!userChoseMode && meta && meta.filePath) {
      applyMode('preview', false);
    }
    setContent(String(text), meta || null);
    previewScroll.scrollTop = 0;
  };

  window.__toggleWide = function () {
    applyWide(!wide, true);
  };

  window.__setFullScreen = function (isFS) {
    applyFullScreenState(Boolean(isFS));
  };

  window.__exportHTML = function () {
    var html = buildExportDocument();
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.export) {
      window.webkit.messageHandlers.export.postMessage(html);
    } else {
      document.getElementById('export').click();
    }
  };
})();
