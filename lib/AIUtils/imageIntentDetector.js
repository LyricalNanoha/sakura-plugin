import { getAI } from "./getAI.js"
import { executeToolCalls } from "./tools/tools.js"
import setting from "../setting.js"
import { IMAGE_INTENT_SYSTEM_PROMPT } from "./imagePromptConfig.js"
import { retrieveTags, hasArtistRequest, semanticRetrieve } from "./animaTagRetriever.js"

export async function checkImageIntent(e, conversationHistory, channel) {
  const comfyConfig = setting.getConfig("ComfyUI")
  if (!comfyConfig?.enabled) return

  const lastUserMsg = conversationHistory
    .filter(item => item.role === "user")
    .pop()

  if (!lastUserMsg) return

  const userTextParts = lastUserMsg.parts?.filter(p => p.text) || []
  const userText = userTextParts.map(p => p.text).join("")
  if (!userText) return

  const hasImage = !!(e.img && e.img.length > 0)

  const recentHistory = conversationHistory
    .filter(item => item.role === "user" || item.role === "model")
    .slice(-10)

  const contextNote = hasImage ? "\n（注意：用户消息中附带了图片）" : ""

  // RAG 标签检索：关键词 + 语义双层检索
  const includeArtist = hasArtistRequest(userText)
  const ragResult = retrieveTags(userText, { includeArtist })
  let ragContext = ragResult.context ? `\n\n【参考标签】\n${ragResult.context}` : ""

  // 语义增强：关键词匹配不足时使用向量检索补充
  if (!ragResult.characters || ragResult.characters.length === 0) {
    const semanticResults = await semanticRetrieve(userText)
    if (semanticResults.length > 0) {
      const semanticTags = semanticResults
        .map(r => `${r.name}（${r.cnName}）${r.wiki ? " - " + r.wiki.slice(0, 60) : ""}`)
        .join("\n")
      ragContext += `\n\n【语义检索补充】\n${semanticTags}`
    }
  }

  try {
    const response = await getAI(
      channel,
      e,
      [{ text: `用户刚才说：「${userText}」${contextNote}${ragContext}\n请判断是否有生图意图。` }],
      IMAGE_INTENT_SYSTEM_PROMPT,
      false,
      true,
      recentHistory,
    )

    if (typeof response === "string") return

    const functionCalls = response.functionCalls
    if (functionCalls && functionCalls.length > 0) {
      const hasImageCall = functionCalls.some(fc => fc.name === "generateImage" || fc.name === "generateAnimeImage")
      if (hasImageCall) {
        const imageCalls = functionCalls.filter(fc => fc.name === "generateImage" || fc.name === "generateAnimeImage")
        await executeToolCalls(e, imageCalls)
        logger.info("[ImageIntent] 检测到生图意图，已生成图片")
      }
    }
  } catch (err) {
    logger.warn(`[ImageIntent] 意图检测失败: ${err.message}`)
  }
}
