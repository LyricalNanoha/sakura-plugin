import { retrieveTags, hasArtistRequest, loadVocabIndex } from "../animaTagRetriever.js"
import { warmupIndex } from "../semanticTagSearch.js"

// 启动时只加载向量缓存（不加载 ONNX 模型），实际模型在首次语义搜索时懒加载
warmupIndex()

export class TagSearchTool {
  name = "searchTags"
  description = "查询 Danbooru 标签。在使用 generateImage 生图之前必须先调用此工具查询准确标签。输入角色名/动作/概念的中文，返回正确的英文 Danbooru 标签和描述。"

  parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "查询关键词。优先使用用户原文中的中文（如「伊芙琳」「虹夏」「足控」），也支持英文标签名（如 frieren）。多个关键词用空格分隔。",
      },
      semantic: {
        type: "boolean",
        description: "是否启用语义搜索（当精确匹配无结果时设为true）。默认false。",
      },
    },
    required: ["query"],
  }

  function() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    }
  }

  func = async (opts) => {
    const { query, semantic = false } = opts
    if (!query) return "请提供查询关键词"

    const includeArtist = hasArtistRequest(query)
    const ragResult = retrieveTags(query, { includeArtist })

    let response = ""

    // 反向匹配补充：关键词中包含 query 的角色也加入结果（返回多个供 AI 挑选）
    if (query.length >= 2) {
      const vocab = loadVocabIndex()
      if (vocab) {
        const queryClean = query.toLowerCase().trim()
        const existingTags = new Set(ragResult.characters.map(c => c.characterTag))
        for (const [cnKey, entry] of vocab) {
          if (entry.category === 4 && cnKey.includes(queryClean) && !existingTags.has(entry.tag.replace(/_/g, " "))) {
            ragResult.characters.push({
              characterTag: entry.tag.replace(/_/g, " "),
              appearance: entry.wiki || "",
              series: "",
            })
          }
        }
        // 按权重排序，最多返回 5 个角色供 AI 挑选
        if (ragResult.characters.length > 5) {
          ragResult.characters = ragResult.characters.slice(0, 5)
        }
      }
    }

    if (ragResult.characters.length > 0) {
      response += "【角色】\n"
      for (const ch of ragResult.characters) {
        response += `- 标签: ${ch.characterTag}\n`
        if (ch.appearance) response += `  外貌: ${ch.appearance}\n`
        if (ch.series) response += `  作品: ${ch.series}\n`
      }
    }

    if (ragResult.tags.length > 0) {
      const grouped = {}
      for (const t of ragResult.tags) {
        if (!grouped[t.category]) grouped[t.category] = []
        grouped[t.category].push(t.tags)
      }
      const names = { action: "动作", clothing: "服装", body: "属性", scene: "场景", composition: "构图" }
      for (const [cat, tagList] of Object.entries(grouped)) {
        response += `【${names[cat] || cat}】${tagList.join(", ")}\n`
      }
    }

    if (ragResult.vocabTags && ragResult.vocabTags.length > 0) {
      response += "【词汇匹配】\n"
      for (const v of ragResult.vocabTags) {
        response += `- ${v.cn} → ${v.tag}`
        if (v.wiki) response += ` (${v.wiki.slice(0, 40)})`
        response += "\n"
      }
    }

    if (ragResult.artistTags) {
      response += `【画师】${ragResult.artistTags}\n`
    }

    // 语义搜索（仅在 semantic=true 且关键词无角色结果时）
    if (semantic && ragResult.characters.length === 0) {
      try {
        const { semanticSearch, isIndexReady } = await import("../semanticTagSearch.js")
        if (isIndexReady()) {
          const results = await semanticSearch(query, 5)
          const filtered = results.filter(r => r.score > 0.35)
          if (filtered.length > 0) {
            response += "【语义检索】\n"
            for (const r of filtered) {
              response += `- ${r.tag}（${r.cnName}）score:${r.score.toFixed(2)}`
              if (r.wiki) response += ` - ${r.wiki.slice(0, 50)}`
              response += "\n"
            }
          }
        } else {
          response += "（语义索引尚未就绪，仅返回关键词匹配结果）\n"
        }
      } catch {
        // 语义搜索不可用时静默降级
      }
    }

    if (!response) {
      const isEnglishOnly = /^[a-zA-Z0-9\s\-_.,():'"!?]+$/.test(query)
      if (isEnglishOnly) {
        response = `未找到"${query}"的匹配标签。提示：请尝试使用中文关键词（如角色的中文名）查询，匹配率更高。或设置 semantic:true 进行语义搜索。`
      } else {
        response = `未找到"${query}"的匹配标签。建议：尝试 semantic:true 语义搜索，或换个关键词。`
      }
    }

    return response.trim()
  }
}
