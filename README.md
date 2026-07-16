# 音频工坊 · 本地音频编辑器（PWA）

一个运行在浏览器（安卓 Chrome 等）的音频编辑应用：从手机选择**多个**音频文件，进行**剪辑 / 分割 / 拼接 / 重排 / 淡入淡出 / 音量**等处理，最终**导出并保存到本地**。纯前端，无服务端，**不上传任何音频**。可作为 PWA 安装到安卓主屏幕，离线可用。

## 功能

- **多文件导入**：一次选择多个音频，支持 mp3 / wav / m4a / aac / ogg / flac / opus / webm 等浏览器可解码格式。
- **剪辑（裁剪）**：在每个片段的大波形上拖动左右手柄设置入点/出点。
- **分割**：在波形上点按定位分割标记，一键将片段分成两段。
- **拼接 / 重排**：时间线水平滚动，拖动或用 ↑↓ 按钮调整片段顺序。
- **复制 / 删除**：快速复制或移除片段。
- **淡入 / 淡出**：每个片段独立的淡入、淡出时长（0–5s）。
- **音量**：每个片段独立增益（0–200%）。
- **试听**：整条时间线播放/暂停/停止/拖动定位，或单段试听；带移动播放头。
- **撤销 / 重做**：编辑历史（Ctrl+Z / Ctrl+Y）。
- **导出**：渲染为 **WAV**（无损，恒可用）或 **MP3**（可选码率，依赖 lamejs），保存到本地。

## 运行

由于使用 ES 模块，需通过 http 访问（不能直接双击 file:// 打开）。

```bash
# 在本目录下
node server.js          # 默认 8080 端口
# 或指定端口
PORT=9000 node server.js
```

启动后控制台会打印本机与局域网地址：

- **桌面试用**：浏览器打开 `http://localhost:8080`
- **手机试用**（同 Wi-Fi）：用安卓 Chrome 打印的局域网地址

## 安装为安卓应用（PWA）

PWA 安装需 https（`localhost` 例外）。推荐做法：

1. 把整个目录部署到任意静态托管（如 **GitHub Pages**、Netlify、Vercel、Cloudflare Pages）。
2. 用安卓 Chrome 访问该 https 地址 → 菜单 → **"添加到主屏幕"**。
3. 之后从主屏幕图标启动即为全屏独立应用，离线可用。

> 本地局域网（http）也能正常使用全部编辑功能，仅"安装到主屏幕"这一步需要 https。

## 支持的音频格式

取决于浏览器解码能力。Chrome（安卓/桌面）通常可解码：mp3、wav、m4a/aac、ogg/oga、flac、opus、webm 音频。导出固定为 WAV/MP3。

## 目录结构

```
index.html              # 应用外壳
manifest.webmanifest    # PWA 清单
sw.js                   # Service Worker（离线缓存）
server.js               # 本地静态服务器
css/styles.css          # 样式
js/
  app.js                # 入口：状态编排、历史、事件
  audio-engine.js       # 解码 / 播放 / 渲染 / 编码
  waveform.js           # 波形绘制与交互
  ui.js                 # DOM 渲染
lib/lame.min.js         # MP3 编码器（vendored）
icons/                  # 应用图标
tools/                  # 图标生成、测试音频生成等脚本
```

## 开发与自测

```bash
node --check js/*.js server.js sw.js tools/*.js   # 语法检查
node tools/make-icons.js                          # 重新生成图标
node tools/make-test-audio.js                     # 生成测试用正弦 WAV
node server.js                                    # 启动
```

架构说明：当前为**单轨**（一条时间线顺序拼接片段），数据模型已用 `tracks[]` 结构，为将来**多轨混音**预留扩展点。

## 许可

代码 MIT；`lib/lame.min.js` 为其各自 LGPL 许可。
