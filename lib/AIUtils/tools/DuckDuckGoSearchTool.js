import axios from "axios"

function getProxyConfig() {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
  if (!proxyUrl) return undefined

  try {
    const url = new URL(proxyUrl)
    const config = {
      host: url.hostname,
      port: parseInt(url.port),
      protocol: url.protocol,
    }
    if (url.username) {
      config.auth = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
    }
    return config
  } catch {
    return undefined
  }
}

export class DuckDuckGoSearchTool {
  name = "WebSearch"
  description = "使用Google搜索引擎搜索网页获取实时信息。当需要查询最新事件、实时数据、未知事物时使用。"

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

    const proxy = getProxyConfig()

    const results = await searchGoogle(query, count, proxy)
    if (results) return results

    const ddgResults = await searchDuckDuckGo(query, count, proxy)
    if (ddgResults) return ddgResults

    return `未找到"${query}"的相关结果。`
  }
}

async function searchGoogle(query, count, proxy) {
  try {
    const requestConfig = {
      params: { q: query, num: count, hl: "zh-CN" },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      timeout: 15000,
    }
    if (proxy) requestConfig.proxy = proxy

    const response = await axios.get("https://www.google.com/search", requestConfig)
    const html = response.data

    const results = parseGoogleResults(html, count)
    if (results.length === 0) return null

    return results.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
    ).join("\n\n")
  } catch (err) {
    logger.warn(`[WebSearch] Google搜索失败: ${err.message}，尝试DuckDuckGo...`)
    return null
  }
}

async function searchDuckDuckGo(query, count, proxy) {
  try {
    const requestConfig = {
      params: { q: query },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      timeout: 15000,
    }
    if (proxy) requestConfig.proxy = proxy

    const response = await axios.get("https://html.duckduckgo.com/html/", requestConfig)
    const html = response.data

    const results = parseDuckDuckGoResults(html, count)
    if (results.length === 0) return null

    return results.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
    ).join("\n\n")
  } catch (err) {
    logger.warn(`[WebSearch] DuckDuckGo搜索失败: ${err.message}`)
    return null
  }
}

function parseGoogleResults(html, maxCount) {
  const results = []
  const blockRegex = /<div class="[^"]*"[^>]*><div[^>]*><a href="(\/url\?q=[^"]+)"[^>]*><h3[^>]*>([\s\S]*?)<\/h3>/gi
  let match

  while ((match = blockRegex.exec(html)) !== null && results.length < maxCount) {
    let url = match[1]
    const qMatch = url.match(/\/url\?q=([^&]+)/)
    if (qMatch) url = decodeURIComponent(qMatch[1])
    const title = stripHtml(match[2])
    if (title && url.startsWith("http")) {
      results.push({ title, url, snippet: "" })
    }
  }

  if (results.length === 0) {
    const altRegex = /<a href="\/url\?q=([^"&]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi
    while ((match = altRegex.exec(html)) !== null && results.length < maxCount) {
      const url = decodeURIComponent(match[1])
      const title = stripHtml(match[2])
      if (title && url.startsWith("http")) {
        results.push({ title, url, snippet: "" })
      }
    }
  }

  const snippetRegex = /<span class="[^"]*">([\s\S]*?)<\/span>[\s\S]*?<\/div>[\s\S]*?<\/div>/gi
  const snippets = []
  while ((match = snippetRegex.exec(html)) !== null && snippets.length < maxCount) {
    const text = stripHtml(match[1])
    if (text.length > 30) snippets.push(text)
  }

  for (let i = 0; i < results.length; i++) {
    if (snippets[i]) results[i].snippet = snippets[i]
  }

  return results
}

function parseDuckDuckGoResults(html, maxCount) {
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
    if (uddgMatch) url = decodeURIComponent(uddgMatch[1])
    results.push({ title: titles[i].title, url, snippet: snippets[i] || "" })
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
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
