import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TAG_DB_PATH = path.resolve(__dirname, "../../resources/AI/tags/anima_tags.json")
const ENHANCED_PATH = path.resolve(__dirname, "../../resources/AI/tags/tags_enhanced.csv")
const VOCAB_PATH = path.resolve(__dirname, "../../resources/AI/tags/danbooru.csv")
const VOCAB_LEGACY_PATH = path.resolve(__dirname, "../../resources/AI/tags/提示词汇库.txt")

let tagDB = null
let vocabIndex = null

function loadTagDB() {
  if (tagDB) return tagDB
  try {
    const raw = fs.readFileSync(TAG_DB_PATH, "utf-8")
    tagDB = JSON.parse(raw)
    return tagDB
  } catch (err) {
    logger.warn(`[AnimaTagRetriever] 加载标签库失败: ${err.message}`)
    return null
  }
}

/**
 * 加载词汇库（支持多种格式，按优先级选择）
 * 优先级: tags_enhanced.csv > danbooru.csv > 提示词汇库.txt
 */
function loadVocabIndex() {
  if (vocabIndex) return vocabIndex
  try {
    let vocabFile = null
    let format = ""

    if (fs.existsSync(ENHANCED_PATH)) {
      vocabFile = ENHANCED_PATH
      format = "enhanced"
    } else if (fs.existsSync(VOCAB_PATH)) {
      vocabFile = VOCAB_PATH
      format = "danbooru"
    } else if (fs.existsSync(VOCAB_LEGACY_PATH)) {
      vocabFile = VOCAB_LEGACY_PATH
      format = "legacy"
    }
    if (!vocabFile) return null

    const raw = fs.readFileSync(vocabFile, "utf-8")
    const lines = raw.split("\n")
    vocabIndex = new Map()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim() || i === 0 && format === "enhanced") continue

      if (format === "enhanced") {
        // tags_enhanced.csv: name,cn_name,wiki,post_count,category,nsfw
        const parsed = parseCSVLine(line)
        if (parsed.length < 5) continue

        const tag = parsed[0]
        const cnField = parsed[1]
        const wiki = parsed[2] || ""
        const weight = parseInt(parsed[3]) || 0
        const category = parseInt(parsed[4]) || 0

        if (cnField && /[\u4e00-\u9fff]/.test(cnField)) {
          const cnParts = cnField.split(",")
          for (const cn of cnParts) {
            const trimmed = cn.trim()
            if (trimmed.length >= 2 && /[\u4e00-\u9fff]/.test(trimmed)) {
              const existing = vocabIndex.get(trimmed)
              if (!existing || weight > existing.weight) {
                vocabIndex.set(trimmed, { tag, weight, category, wiki })
              }
            }
          }
        }
      } else if (format === "danbooru") {
        // danbooru.csv: tag,category,count,"aliases",chinese,extra
        const parsed = parseCSVLine(line)
        if (parsed.length < 5) continue

        const tag = parsed[0]
        const weight = parseInt(parsed[2]) || 0
        const cnField = parsed[4]

        if (cnField && /[\u4e00-\u9fff]{2,}/.test(cnField)) {
          const cnParts = cnField.split("|")
          for (const cn of cnParts) {
            const trimmed = cn.trim()
            if (trimmed.length >= 2 && /[\u4e00-\u9fff]/.test(trimmed)) {
              const existing = vocabIndex.get(trimmed)
              if (!existing || weight > existing.weight) {
                vocabIndex.set(trimmed, { tag, weight })
              }
            }
          }
        }
      } else {
        // legacy: tag,id,weight,"aliases,中文"
        const firstComma = line.indexOf(",")
        if (firstComma === -1) continue
        const tag = line.substring(0, firstComma).trim()
        const secondComma = line.indexOf(",", firstComma + 1)
        if (secondComma === -1) continue
        const thirdComma = line.indexOf(",", secondComma + 1)
        if (thirdComma === -1) continue

        const weight = parseInt(line.substring(secondComma + 1, thirdComma)) || 0
        let aliasStr = line.substring(thirdComma + 1).trim()
        if (aliasStr.startsWith('"') && aliasStr.endsWith('"')) {
          aliasStr = aliasStr.slice(1, -1)
        }

        for (const part of aliasStr.split(",")) {
          const trimmed = part.trim()
          if (/[\u4e00-\u9fff]{2,}/.test(trimmed)) {
            const cnKey = trimmed.replace(/-.*$/, "").trim()
            if (cnKey.length >= 2) {
              const existing = vocabIndex.get(cnKey)
              if (!existing || weight > existing.weight) {
                vocabIndex.set(cnKey, { tag, weight })
              }
            }
          }
        }
      }
    }

    logger.info(`[AnimaTagRetriever] 词汇库已加载，${vocabIndex.size} 个中文词条 (${format})`)
    return vocabIndex
  } catch (err) {
    logger.warn(`[AnimaTagRetriever] 加载词汇库失败: ${err.message}`)
    return null
  }
}

/**
 * 简易 CSV 行解析（处理引号内的逗号）
 */
function parseCSVLine(line) {
  const fields = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim())
      current = ""
    } else {
      current += ch
    }
  }
  fields.push(current.trim())
  return fields
}

/**
 * 根据用户输入文本检索相关的 Danbooru 标签
 * @param {string} userText - 用户的中文描述
 * @param {object} options - 可选参数
 * @param {boolean} options.includeArtist - 是否检索画师（默认 false，用户指定时才开启）
 * @returns {{ characters: Array, tags: Array, vocabTags: Array, artistTags: string|null, context: string }}
 */
export function retrieveTags(userText, options = {}) {
  const db = loadTagDB()
  const text = userText.toLowerCase()
  const result = {
    characters: [],
    tags: [],
    vocabTags: [],
    artistTags: null,
    context: "",
  }

  if (!db) return result

  // 1. 角色检索（结构化数据库）
  if (db.characters?.entries) {
    for (const entry of db.characters.entries) {
      const matched = entry.keywords.some(kw => text.includes(kw.toLowerCase()))
      if (matched) {
        result.characters.push({
          characterTag: entry.tags,
          appearance: entry.appearance,
          series: entry.series,
        })
      }
    }
  }

  // 2. 动作检索
  if (db.actions?.entries) {
    for (const entry of db.actions.entries) {
      const matched = entry.keywords.some(kw => text.includes(kw))
      if (matched) {
        result.tags.push({ category: "action", tags: entry.tags })
      }
    }
  }

  // 3. 服装检索
  if (db.clothing?.entries) {
    for (const entry of db.clothing.entries) {
      const matched = entry.keywords.some(kw => text.includes(kw.toLowerCase()))
      if (matched) {
        result.tags.push({ category: "clothing", tags: entry.tags })
      }
    }
  }

  // 4. 身体属性检索
  if (db.bodyAttributes?.entries) {
    for (const entry of db.bodyAttributes.entries) {
      const matched = entry.keywords.some(kw => text.includes(kw))
      if (matched) {
        result.tags.push({ category: "body", tags: entry.tags })
      }
    }
  }

  // 5. 场景检索
  if (db.scenes?.entries) {
    for (const entry of db.scenes.entries) {
      const matched = entry.keywords.some(kw => text.includes(kw))
      if (matched) {
        result.tags.push({ category: "scene", tags: entry.tags })
      }
    }
  }

  // 6. 构图检索
  if (db.compositions?.entries) {
    for (const entry of db.compositions.entries) {
      const matched = entry.keywords.some(kw => text.includes(kw))
      if (matched) {
        result.tags.push({ category: "composition", tags: entry.tags })
      }
    }
  }

  // 7. 画师检索（仅用户明确指定时）
  if (options.includeArtist && db.artists?.categories) {
    for (const [catName, cat] of Object.entries(db.artists.categories)) {
      const matched = cat.keywords.some(kw => text.includes(kw))
      if (matched) {
        result.artistTags = cat.artists.slice(0, 2).join(", ")
        break
      }
    }
  }

  // 8. 词汇库补充检索：从增强词汇库中查找角色和通用标签
  const vocab = loadVocabIndex()
  if (vocab) {
    const alreadyMatchedTags = new Set([
      ...result.characters.map(c => c.characterTag),
      ...result.tags.map(t => t.tags),
    ].join(", ").split(", ").map(s => s.trim()))

    for (const [cnKey, entry] of vocab) {
      if (!text.includes(cnKey) || alreadyMatchedTags.has(entry.tag)) continue

      // category=4 是角色标签，补充到 characters（如果结构化库没命中）
      if (entry.category === 4 && result.characters.length === 0) {
        result.characters.push({
          characterTag: entry.tag.replace(/_/g, " "),
          appearance: entry.wiki || "",
          series: "",
        })
        alreadyMatchedTags.add(entry.tag)
      } else {
        result.vocabTags.push({ cn: cnKey, tag: entry.tag, weight: entry.weight, wiki: entry.wiki })
      }
    }
    // 按权重排序，只取前 8 个最相关的补充标签
    result.vocabTags.sort((a, b) => b.weight - a.weight)
    result.vocabTags = result.vocabTags.slice(0, 8)
  }

  // 组装上下文字符串供 AI 参考
  result.context = buildContext(result)
  return result
}

function buildContext(result) {
  const lines = []

  if (result.characters.length > 0) {
    lines.push("【角色参考】（如果只画该角色、不含我自己，请设 includeSelf=false）")
    for (const ch of result.characters) {
      lines.push(`- 角色标签: ${ch.characterTag}`)
      if (ch.appearance) lines.push(`  外貌: ${ch.appearance}`)
    }
  }

  if (result.tags.length > 0) {
    const grouped = {}
    for (const t of result.tags) {
      if (!grouped[t.category]) grouped[t.category] = []
      grouped[t.category].push(t.tags)
    }

    const categoryNames = {
      action: "动作",
      clothing: "服装",
      body: "属性",
      scene: "场景",
      composition: "构图",
    }

    for (const [cat, tagList] of Object.entries(grouped)) {
      lines.push(`【${categoryNames[cat] || cat}参考标签】${tagList.join(", ")}`)
    }
  }

  if (result.vocabTags && result.vocabTags.length > 0) {
    const vocabParts = result.vocabTags.map(v => `${v.cn}→${v.tag}`)
    lines.push(`【词汇参考】${vocabParts.join(", ")}`)
  }

  if (result.artistTags) {
    lines.push(`【推荐画师】${result.artistTags}`)
  }

  return lines.join("\n")
}

/**
 * 检查用户文本中是否有明确指定画师的意图
 */
export function hasArtistRequest(userText) {
  const artistPatterns = [
    /画师|画风|风格.*(?:像|类似|参考)/,
    /@\w+/,
    /wlop|rella|guweiz|krenz|nixeu|kantoku|anmi|mika.?pikazo/i,
  ]
  return artistPatterns.some(p => p.test(userText))
}

/**
 * 热重载标签库（配置文件修改后可调用）
 */
export function reloadTagDB() {
  tagDB = null
  return loadTagDB()
}
