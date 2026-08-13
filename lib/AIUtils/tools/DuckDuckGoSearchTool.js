import axios from "axios"

function getProxyConfig() {
  const proxyUrl = process.env.SAKURA_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
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
  description = "使用搜索引擎搜索网页获取实时信息。当需要查询最新事件、实时数据、未知事物时使用。"

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

    const results = await searchDuckDuckGoLite(query, count, proxy)
    if (results) return results

    const fallback = await searchDuckDuckGoHTML(query, count, proxy)
    if (fallback) return fallback

    return `未找到"${query}"的相关结果。`
  }
}

async function searchDuckDuckGoLite(query, count, proxy) {
  try {
    const requestConfig = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      timeout: 15000,
    }
    if (proxy) requestConfig.proxy = proxy

    const response = await axios.post(
      "https://lite.duckduckgo.com/lite/",
      `q=${encodeURIComponent(query)}`,
      requestConfig
    )
    const html = response.data

    if (html.includes("anomaly-modal") || html.includes("bot-challenge")) {
      logger.warn(`[WebSearch] DuckDuckGo Lite触发了机器人检测，跳过`)
      return null
    }

    const results = parseDDGLiteResults(html, count)
    if (results.length === 0) return null

    return results.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
    ).join("\n\n")
  } catch (err) {
    logger.warn(`[WebSearch] DuckDuckGo Lite搜索失败: ${err.message}`)
    return null
  }
}

async function searchDuckDuckGoHTML(query, count, proxy) {
  try {
    const requestConfig = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 15000,
    }
    if (proxy) requestConfig.proxy = proxy

    const response = await axios.post(
      "https://html.duckduckgo.com/html/",
      `q=${encodeURIComponent(query)}`,
      requestConfig
    )
    const html = response.data

    const results = parseDDGHTMLResults(html, count)
    if (results.length === 0) return null

    return results.map((r, i) =>
      `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
    ).join("\n\n")
  } catch (err) {
    logger.warn(`[WebSearch] DuckDuckGo HTML搜索失败: ${err.message}`)
    return null
  }
}

function parseDDGLiteResults(html, maxCount) {
  const results = []
  const linkRegex = /<a[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi
  const hrefRegex = /href=["']([^"']+)["']/i
  const snippetRegex = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi

  const titles = []
  let match
  while ((match = linkRegex.exec(html)) !== null) {
    const hrefMatch = match[0].match(hrefRegex)
    if (hrefMatch) {
      titles.push({ url: hrefMatch[1], title: stripHtml(match[1]) })
    }
  }

  const snippets = []
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1]))
  }

  for (let i = 0; i < Math.min(titles.length, maxCount); i++) {
    let url = titles[i].url
    if (url.startsWith("//")) url = "https:" + url
    results.push({ title: titles[i].title, url, snippet: snippets[i] || "" })
  }

  return results
}

function parseDDGHTMLResults(html, maxCount) {
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
