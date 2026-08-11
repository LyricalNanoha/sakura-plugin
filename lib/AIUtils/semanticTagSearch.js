import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TAGS_CSV_PATH = path.resolve(__dirname, "../../resources/AI/tags/tags_enhanced.csv")
const INDEX_CACHE_PATH = path.resolve(__dirname, "../../resources/AI/tags/embeddings_cache.bin")
const META_CACHE_PATH = path.resolve(__dirname, "../../resources/AI/tags/embeddings_meta.json")

const MODEL_NAME = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
const EMBEDDING_DIM = 384
const TOP_K_DEFAULT = 5

let extractor = null
let indexData = null // { tags: [...], vectors: Float32Array }
let isLoading = false
let loadPromise = null

/**
 * 获取 embedding pipeline（懒加载，首次约需 5-10s 下载模型）
 */
async function getExtractor() {
  if (extractor) return extractor
  const { pipeline } = await import("@huggingface/transformers")
  extractor = await pipeline("feature-extraction", MODEL_NAME, {
    dtype: "q8",
    revision: "main",
  })
  logger.info("[SemanticSearch] Embedding 模型已加载")
  return extractor
}

/**
 * 解析 CSV，提取用于 embedding 的文本和元数据
 */
function parseTagsCSV() {
  if (!fs.existsSync(TAGS_CSV_PATH)) return []

  const raw = fs.readFileSync(TAGS_CSV_PATH, "utf-8")
  const lines = raw.split("\n")
  const entries = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const parsed = parseCSVLine(line)
    if (parsed.length < 5) continue

    const tag = parsed[0]
    const cnName = parsed[1]
    const wiki = parsed[2] || ""
    const postCount = parseInt(parsed[3]) || 0
    const category = parseInt(parsed[4]) || 0

    if (!cnName || postCount < 50) continue

    // 构造 embedding 文本：中文名 + 标签名 + wiki 摘要
    const searchText = `${cnName} ${tag.replace(/_/g, " ")} ${wiki.slice(0, 60)}`
    entries.push({ tag, cnName, wiki, postCount, category, searchText })
  }

  return entries
}

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
 * 构建或加载 embedding 索引
 */
async function loadIndex() {
  if (indexData) return indexData
  if (isLoading) return loadPromise

  isLoading = true
  loadPromise = _doLoadIndex()
  try {
    indexData = await loadPromise
    return indexData
  } finally {
    isLoading = false
  }
}

async function _doLoadIndex() {
  // 尝试从缓存加载
  if (fs.existsSync(INDEX_CACHE_PATH) && fs.existsSync(META_CACHE_PATH)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_CACHE_PATH, "utf-8"))
      const buffer = fs.readFileSync(INDEX_CACHE_PATH)
      const vectors = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)

      if (meta.count * EMBEDDING_DIM === vectors.length) {
        logger.info(`[SemanticSearch] 从缓存加载了 ${meta.count} 条 embedding`)
        return { tags: meta.tags, vectors }
      }
    } catch (err) {
      logger.warn(`[SemanticSearch] 缓存读取失败，重新构建: ${err.message}`)
    }
  }

  // 需要重新构建索引
  logger.info("[SemanticSearch] 开始构建 embedding 索引（首次约需 2-5 分钟）...")
  const entries = parseTagsCSV()
  if (entries.length === 0) return null

  const ext = await getExtractor()
  const batchSize = 64
  const allVectors = new Float32Array(entries.length * EMBEDDING_DIM)

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    const texts = batch.map(e => e.searchText)
    const output = await ext(texts, { pooling: "mean", normalize: true })
    const data = output.data

    for (let j = 0; j < batch.length; j++) {
      const offset = (i + j) * EMBEDDING_DIM
      for (let d = 0; d < EMBEDDING_DIM; d++) {
        allVectors[offset + d] = data[j * EMBEDDING_DIM + d]
      }
    }

    if ((i + batchSize) % 1000 < batchSize) {
      logger.info(`[SemanticSearch] 进度: ${Math.min(i + batchSize, entries.length)}/${entries.length}`)
    }
  }

  // 保存缓存
  const meta = {
    count: entries.length,
    model: MODEL_NAME,
    dim: EMBEDDING_DIM,
    tags: entries.map(e => ({ tag: e.tag, cnName: e.cnName, wiki: e.wiki, category: e.category, postCount: e.postCount })),
  }
  fs.writeFileSync(META_CACHE_PATH, JSON.stringify(meta))
  fs.writeFileSync(INDEX_CACHE_PATH, Buffer.from(allVectors.buffer))
  logger.info(`[SemanticSearch] 索引构建完成，${entries.length} 条已缓存`)

  return { tags: meta.tags, vectors: allVectors }
}

/**
 * 语义搜索：输入中文查询，返回最相关的标签
 * 使用 post_count 加权：热门标签在语义相似度相近时排名更靠前
 * 加权公式：finalScore = cosineSimilarity * (1 + log10(postCount) * 0.05)
 * @param {string} query - 用户查询文本
 * @param {number} topK - 返回数量
 * @returns {Promise<Array<{tag, cnName, wiki, category, postCount, score}>>}
 */
export async function semanticSearch(query, topK = TOP_K_DEFAULT) {
  const index = await loadIndex()
  if (!index) return []

  const ext = await getExtractor()
  const queryOutput = await ext(query, { pooling: "mean", normalize: true })
  const queryVec = queryOutput.data

  // 计算余弦相似度（向量已归一化，点积即余弦）+ post_count 热度加权
  const scores = []
  for (let i = 0; i < index.tags.length; i++) {
    let dot = 0
    const offset = i * EMBEDDING_DIM
    for (let d = 0; d < EMBEDDING_DIM; d++) {
      dot += queryVec[d] * index.vectors[offset + d]
    }
    const postCount = index.tags[i].postCount || 100
    const popularityBoost = 1 + Math.log10(Math.max(postCount, 1)) * 0.05
    scores.push({ idx: i, score: dot * popularityBoost })
  }

  // 排序取 top-K
  scores.sort((a, b) => b.score - a.score)
  return scores.slice(0, topK).map(s => ({
    ...index.tags[s.idx],
    score: s.score,
  }))
}

/**
 * 检查索引是否已就绪（避免阻塞主流程）
 */
export function isIndexReady() {
  return indexData !== null
}

/**
 * 后台预热索引（不阻塞）
 */
export function warmupIndex() {
  loadIndex().catch(err => {
    logger.warn(`[SemanticSearch] 索引预热失败: ${err.message}`)
  })
}
