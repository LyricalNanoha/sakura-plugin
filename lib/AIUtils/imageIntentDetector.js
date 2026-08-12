import { getAI } from "./getAI.js"
import { executeToolCalls } from "./tools/tools.js"
import setting from "../setting.js"
import { IMAGE_INTENT_SYSTEM_PROMPT } from "./imagePromptConfig.js"

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

  try {
    let intentHistory = [
      ...recentHistory,
      { role: "user", parts: [{ text: `用户刚才说：「${userText}」${contextNote}\n请判断是否有生图意图。` }] },
    ]

    let maxRounds = 3
    for (let i = 0; i < maxRounds; i++) {
      const response = await getAI(
        channel,
        e,
        i === 0 ? [{ text: `用户刚才说：「${userText}」${contextNote}\n请判断是否有生图意图。` }] : "",
        IMAGE_INTENT_SYSTEM_PROMPT,
        false,
        true,
        i === 0 ? recentHistory : intentHistory,
      )

      if (typeof response === "string") return

      const functionCalls = response.functionCalls
      if (!functionCalls || functionCalls.length === 0) return

      const hasImageCall = functionCalls.some(fc => fc.name === "generateImage" || fc.name === "generateAnimeImage")

      if (hasImageCall) {
        const imageCalls = functionCalls.filter(fc => fc.name === "generateImage" || fc.name === "generateAnimeImage")
        await executeToolCalls(e, imageCalls)
        logger.info("[ImageIntent] 检测到生图意图，已生成图片")
        return
      }

      // 非 generateImage 的工具调用（如 searchTags）：执行后继续循环
      intentHistory.push({
        role: "model",
        parts: functionCalls.map(fc => ({ functionCall: { id: fc.id, name: fc.name, args: fc.args } })),
      })

      const executedResults = await executeToolCalls(e, functionCalls)
      intentHistory.push(...executedResults)
    }
  } catch (err) {
    logger.warn(`[ImageIntent] 意图检测失败: ${err.message}`)
  }
}
