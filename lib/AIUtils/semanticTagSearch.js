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
const INDEX_VERSION = 2 // 递增此值强制重建索引

let extractor = null
let indexData = null // { tags: [...], vectors: Float32Array }
let isLoading = false
let loadPromise = null

/**
 * 获取 embedding pipeline（懒加载，首次约需 5-10s 下载模型）
 * 自动检测中国网络环境并使用 HF 镜像
 */
async function getExtractor() {
  if (extractor) return extractor
  const { pipeline, env } = await import("@huggingface/transformers")

  // 国内环境：设置 HF 镜像加速下载
  if (!process.env.HF_ENDPOINT) {
    env.remoteHost = "https://hf-mirror.com"
    env.remotePathTemplate = "{model}/resolve/{revision}/"
  }

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

    // 构造 embedding 文本：标签名优先 + 中文首名 + wiki 摘要（缩短以减少噪声稀释）
    const primaryCn = cnName.split(",")[0].trim()
    const searchText = `${tag.replace(/_/g, " ")} ${primaryCn} ${wiki.slice(0, 25)}`
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

const PROGRESS_PATH = path.resolve(__dirname, "../../resources/AI/tags/embeddings_progress.json")

async function _doLoadIndex() {
  // 计算 CSV 指纹用于缓存校验
  let csvFingerprint = ""
  try {
    const stat = fs.statSync(TAGS_CSV_PATH)
    csvFingerprint = `${stat.size}_${stat.mtimeMs}`
  } catch {}

  // 尝试从缓存加载
  if (fs.existsSync(INDEX_CACHE_PATH) && fs.existsSync(META_CACHE_PATH)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_CACHE_PATH, "utf-8"))
      const buffer = fs.readFileSync(INDEX_CACHE_PATH)
      const vectors = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)

      if (meta.count * EMBEDDING_DIM === vectors.length && meta.csvFingerprint === csvFingerprint && meta.version === INDEX_VERSION) {
        logger.info(`[SemanticSearch] 从缓存加载了 ${meta.count} 条 embedding`)
        return { tags: meta.tags, vectors }
      }
      if (meta.version !== INDEX_VERSION) {
        logger.info(`[SemanticSearch] 索引版本已更新 (${meta.version || 1} → ${INDEX_VERSION})，将重建`)
      } else if (meta.csvFingerprint !== csvFingerprint) {
        logger.info(`[SemanticSearch] CSV 已更新，缓存失效，将重建索引`)
      }
    } catch (err) {
      logger.warn(`[SemanticSearch] 缓存读取失败，重新构建: ${err.message}`)
    }
  }

  // 需要重新构建索引（支持断点恢复）
  const entries = parseTagsCSV()
  if (entries.length === 0) return null

  let startFrom = 0
  let allVectors = new Float32Array(entries.length * EMBEDDING_DIM)

  // 检查是否有中断的进度可以恢复
  if (fs.existsSync(PROGRESS_PATH)) {
    try {
      const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf-8"))
      if (progress.total === entries.length && fs.existsSync(INDEX_CACHE_PATH)) {
        const buffer = fs.readFileSync(INDEX_CACHE_PATH)
        const partial = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
        if (partial.length >= progress.done * EMBEDDING_DIM) {
          allVectors.set(partial.subarray(0, progress.done * EMBEDDING_DIM))
          startFrom = progress.done
          logger.info(`[SemanticSearch] 从断点恢复: ${startFrom}/${entries.length}`)
        }
      }
    } catch {}
  }

  if (startFrom === 0) {
    logger.info(`[SemanticSearch] 开始构建 embedding 索引（${entries.length} 条，约需 2-5 分钟）...`)
  }

  const ext = await getExtractor()
  const batchSize = 32
  const saveInterval = 2000

  for (let i = startFrom; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, Math.min(i + batchSize, entries.length))
    const texts = batch.map(e => e.searchText)
    const output = await ext(texts, { pooling: "mean", normalize: true })
    const data = output.data

    for (let j = 0; j < batch.length; j++) {
      const offset = (i + j) * EMBEDDING_DIM
      for (let d = 0; d < EMBEDDING_DIM; d++) {
        allVectors[offset + d] = data[j * EMBEDDING_DIM + d]
      }
    }

    const done = Math.min(i + batchSize, entries.length)

    // 每 saveInterval 条保存一次进度（断点恢复用）
    if (done % saveInterval < batchSize || done === entries.length) {
      fs.writeFileSync(INDEX_CACHE_PATH, Buffer.from(allVectors.buffer))
      fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ done, total: entries.length }))
      logger.info(`[SemanticSearch] 进度: ${done}/${entries.length}（已保存断点）`)
    }
  }

  // 构建完成，保存最终缓存并清理进度文件
  const meta = {
    count: entries.length,
    model: MODEL_NAME,
    dim: EMBEDDING_DIM,
    version: INDEX_VERSION,
    csvFingerprint,
    tags: entries.map(e => ({ tag: e.tag, cnName: e.cnName, wiki: e.wiki, category: e.category, postCount: e.postCount })),
  }
  fs.writeFileSync(META_CACHE_PATH, JSON.stringify(meta))
  fs.writeFileSync(INDEX_CACHE_PATH, Buffer.from(allVectors.buffer))
  if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH)
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
 * 后台预热：仅从缓存加载索引（不触发 ONNX 模型加载/索引构建）
 * 如果缓存不存在，静默跳过——等用户首次调用 searchTags 时再构建
 */
export function warmupIndex() {
  if (indexData) return
  try {
    if (fs.existsSync(INDEX_CACHE_PATH) && fs.existsSync(META_CACHE_PATH)) {
      const meta = JSON.parse(fs.readFileSync(META_CACHE_PATH, "utf-8"))
      const buffer = fs.readFileSync(INDEX_CACHE_PATH)
      const vectors = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)

      let csvFingerprint = ""
      try {
        const stat = fs.statSync(TAGS_CSV_PATH)
        csvFingerprint = `${stat.size}_${stat.mtimeMs}`
      } catch {}

      if (meta.count * EMBEDDING_DIM === vectors.length && meta.csvFingerprint === csvFingerprint && meta.version === INDEX_VERSION) {
        indexData = { tags: meta.tags, vectors }
        logger.info(`[SemanticSearch] 从缓存加载了 ${meta.count} 条 embedding`)
      } else if (meta.version !== INDEX_VERSION) {
        logger.info(`[SemanticSearch] 索引版本已更新，将在首次搜索时重建`)
      } else if (meta.csvFingerprint !== csvFingerprint) {
        logger.info(`[SemanticSearch] CSV 已更新，缓存失效，将在首次搜索时重建`)
      }
    }
  } catch (err) {
    logger.warn(`[SemanticSearch] 缓存预热失败: ${err.message}`)
  }
}
