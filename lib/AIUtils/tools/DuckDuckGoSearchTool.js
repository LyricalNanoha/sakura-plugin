import axios from "axios"

export class DuckDuckGoSearchTool {
  name = "WebSearch"
  description = "使用DuckDuckGo搜索引擎搜索网页获取实时信息。当需要查询最新事件、实时数据、未知事物时使用。"

  parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词",
      },
      count: {
        type: "number",
        description: "返回条数（1-8，默认5）",
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
    const query = (opts.query || "").trim()
    if (!query) return "搜索失败：关键词不能为空"
    const count = Math.max(1, Math.min(parseInt(opts.count) || 5, 8))

    try {
      const response = await axios.get("https://html.duckduckgo.com/html/", {
        params: { q: query },
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        timeout: 15000,
      })

      const html = response.data
      const results = parseSearchResults(html, count)

      if (results.length === 0) {
        return `未找到"${query}"的相关结果。`
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
      ).join("\n\n")

      return formatted
    } catch (err) {
      if (err.code === "ECONNABORTED") return "搜索失败：请求超时（15秒）"
      logger.error(`[DuckDuckGo] 搜索失败: ${err.message}`)
      return `搜索失败：${err.message}`
    }
  }
}

function parseSearchResults(html, maxCount) {
  const results = []
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi

  const titles = []
  let match
  while ((match = resultRegex.exec(html)) !== null) {
    titles.push({ url: match[1], title: stripHtml(match[2]) })
  }

  const snippets = []
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1]))
  }

  for (let i = 0; i < Math.min(titles.length, maxCount); i++) {
    let url = titles[i].url
    const uddgMatch = url.match(/uddg=([^&]+)/)
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1])
    }

    results.push({
      title: titles[i].title,
      url,
      snippet: snippets[i] || "",
    })
  }

  return results
}

function stripHtml(str) {
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
