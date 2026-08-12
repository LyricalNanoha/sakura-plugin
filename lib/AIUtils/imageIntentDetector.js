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

    let maxRounds = 5
    for (let i = 0; i < maxRounds; i++) {
      const extraHint = i >= 2 ? "\n[系统提示：标签搜索已足够，请直接调用 generateImage 生成图片]" : ""
      const response = await getAI(
        channel,
        e,
        i === 0 ? [{ text: `用户刚才说：「${userText}」${contextNote}\n请判断是否有生图意图。` }] : "",
        IMAGE_INTENT_SYSTEM_PROMPT + extraHint,
        false,
        true,
        i === 0 ? recentHistory : intentHistory,
      )

      if (typeof response === "string") return

      const functionCalls = response.functionCalls
      if (!functionCalls || functionCalls.length === 0) {
        // 如果之前调过 searchTags 但模型放弃了，强制再试一次
        const hadSearchTags = intentHistory.some(item =>
          item.role === "model" && item.parts?.some(p => p.functionCall?.name === "searchTags")
        )
        if (hadSearchTags && i < maxRounds - 1) {
          const textContent = response.text || ""
          if (textContent) {
            intentHistory.push({ role: "model", parts: [{ text: textContent }] })
          }
          intentHistory.push({
            role: "user",
            parts: [{ text: "[系统提示] 你已经搜索了标签，现在请直接调用 generateImage 工具生成图片，使用你已知的标签即可。" }],
          })
          i++ // 消耗一轮
          const retryResponse = await getAI(
            channel, e, "",
            IMAGE_INTENT_SYSTEM_PROMPT + "\n[系统提示：标签搜索已足够，请直接调用 generateImage 生成图片]",
            false, true, intentHistory,
          )
          if (typeof retryResponse !== "string" && retryResponse.functionCalls?.length > 0) {
            const retryCalls = retryResponse.functionCalls
            const hasImageCall = retryCalls.some(fc => fc.name === "generateImage" || fc.name === "generateAnimeImage")
            if (hasImageCall) {
              const imageCalls = retryCalls.filter(fc => fc.name === "generateImage" || fc.name === "generateAnimeImage")
              await executeToolCalls(e, imageCalls)
              logger.info("[ImageIntent] 强制重试后生成图片")
              return
            }
          }
        }
        return
      }

      const hasImageCall = functionCalls.some(fc => fc.name === "generateImage" || fc.name === "generateAnimeImage")

      if (hasImageCall) {
        const imageCalls = functionCalls.filter(fc => fc.name === "generateImage" || fc.name === "generateAnimeImage")
        await executeToolCalls(e, imageCalls)
        logger.info("[ImageIntent] 检测到生图意图，已生成图片")
        return
      }

      // 非 generateImage 的工具调用（如 searchTags）：执行后继续循环
      const searchTagsCalls = functionCalls.filter(fc => fc.name === "searchTags")
      const searchCount = intentHistory.filter(item =>
        item.role === "model" && item.parts?.some(p => p.functionCall?.name === "searchTags")
      ).length

      // searchTags 超过 2 次后，不再执行搜索，直接注入强制生图提示
      if (searchCount >= 2 && searchTagsCalls.length > 0) {
        logger.info("[ImageIntent] searchTags 已调用 2 次，强制要求生图")
        intentHistory.push({ role: "model", parts: [{ text: "好的，我已经搜索了足够的标签信息。" }] })
        intentHistory.push({
          role: "user",
          parts: [{ text: "[系统提示] 搜索已完成，请立即调用 generateImage 工具生成图片，使用你目前已知的标签信息。不要再搜索了。" }],
        })
        continue
      }

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
