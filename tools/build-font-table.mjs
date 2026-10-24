/**
 * 把社区字体映射表（JSON）转成扩展可内联的 JS 文件。
 *
 * 用途：学习通 font-cxsecret 字体解码需要「字形轮廓 MD5 → 真实汉字码位」的映射表。
 *   上游是纯 JSON（约 355KB），扩展里不能 fetch 外部 URL（CSP + 离线要求），
 *   所以这里转成一个可静态加载的 JS 文件（约 327KB）。
 *
 * 用法：
 *   node tools/build-font-table.mjs                          # 用内置默认 URL
 *   node tools/build-font-table.mjs <本地json路径>            # 用本地已下载的 JSON
 *
 * 输出：app/extension/font-table.js
 *
 * 为什么用「一行一条 hash 空格 code」而不是 JSON：
 *   JSON 需要引号与逗号，体积约大 40%；运行时 split 一次建 Map 反而更快。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const DEFAULT_URL = 'https://www.forestpolice.org/ttf/2.0/table.json'
const OUT = path.join(ROOT, 'app', 'extension', 'font-table.js')

async function loadJson(arg) {
  if (arg && fs.existsSync(arg)) {
    console.log('读取本地文件:', arg)
    return JSON.parse(fs.readFileSync(arg, 'utf8'))
  }
  const url = arg && /^https?:\/\//.test(arg) ? arg : DEFAULT_URL
  console.log('下载:', url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return JSON.parse(text)
}

const input = process.argv[2]
const raw = await loadJson(input)

// 只保留「8 位 hex → 正整数码位」的条目
const entries = Object.entries(raw).filter(
  ([k, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0 && /^[0-9a-fA-F]{8}$/.test(k)
)
if (!entries.length) {
  console.error('❌ 没有有效条目（期望 {"8位hex": 码位数字}）')
  process.exit(1)
}
console.log('有效条目:', entries.length)

const compact = entries.map(([h, v]) => h + ' ' + v).join('\n')

const out = `/* 学习通 font-cxsecret 字体映射表（${entries.length} 条）
 *
 * 是什么：把「字形轮廓的 MD5（后 8 位）」映射到「真实汉字的 Unicode 码位」。
 *   学习通给每道题内联一个只含该题用字的子集字体，DOM 里是乱码字符，
 *   但字形轮廓与该字真实形状一致 ⇒ 同一个字的轮廓 MD5 恒定。
 *   因此 md5(JSON.stringify(Typr.U.glyphToPath(font, glyphIndex))).slice(24)
 *   可以 100% 精确还原真实汉字，不依赖字形相似度猜测。
 *
 * 数据来源：${DEFAULT_URL}
 *   社区整理并公开分发，覆盖 U+4E00~U+9FA5 全部常用汉字。
 *
 * 本文件由 tools/build-font-table.mjs 生成，请勿手工编辑。
 * 重新生成：node tools/build-font-table.mjs
 */
var SB_FONT_TABLE_RAW = ${JSON.stringify(compact)};

/** 建表（惰性，只做一次）：hash(8 hex) → 汉字码位 */
var SB_FONT_TABLE = null;
function sbFontTable() {
  if (SB_FONT_TABLE) return SB_FONT_TABLE;
  SB_FONT_TABLE = new Map();
  var lines = SB_FONT_TABLE_RAW.split("\\n");
  for (var i = 0; i < lines.length; i++) {
    var sp = lines[i].indexOf(" ");
    if (sp <= 0) continue;
    var h = lines[i].slice(0, sp);
    var code = parseInt(lines[i].slice(sp + 1), 10);
    if (h.length === 8 && code > 0) SB_FONT_TABLE.set(h, code);
  }
  return SB_FONT_TABLE;
}
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, out, 'utf8')
console.log('已写入:', path.relative(ROOT, OUT))
console.log('文件大小:', fs.statSync(OUT).size, '字节')
