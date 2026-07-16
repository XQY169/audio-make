#!/usr/bin/env node
/**
 * 极简静态文件服务器——用于本地或局域网运行本 PWA。
 *
 *   node server.js            # 默认 8080
 *   PORT=9000 node server.js   # 指定端口
 *   node server.js 9000        # 指定端口（位置参数）
 *
 * 启动后会在控制台打印本机局域网地址，方便手机（同 Wi-Fi）扫码访问。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname);
const PORT = Number(process.env.PORT || process.argv[2] || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json; charset=utf-8',
};

const SAFE = /^[A-Za-z0-9._\-/]+$/; // 防目录穿越

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let p = decodeURIComponent(url.pathname);
    if (p.includes('..') || !SAFE.test(p)) return send(res, 400, 'text/plain; charset=utf-8', 'Bad request');

    let fp = path.join(ROOT, p);
    // 目录 → index.html
    let st = fs.statSync(fp);
    if (st.isDirectory()) {
      fp = path.join(fp, 'index.html');
      st = fs.statSync(fp);
    }
    if (!st.isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');

    const ext = path.extname(fp).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'Content-Length': st.size,
    });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    console.error(e);
    send(res, 500, 'text/plain; charset=utf-8', 'Server error');
  }
});

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  音频工坊已启动：');
  console.log(`    本机：    http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`    局域网：  http://${ip}:${PORT}   ← 手机同 Wi-Fi 访问`);
  }
  console.log('\n  提示：在安卓 Chrome 打开局域网地址，菜单选"添加到主屏幕"即可安装为应用。\n  Ctrl+C 退出。\n');
});
