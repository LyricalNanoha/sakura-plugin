import { getAI } from "./getAI.js"
import { executeToolCalls } from "./tools/tools.js"
import setting from "../setting.js"

const IMAGE_INTENT_PROMPT = `你是一个图片生成意图检测器。根据对话上下文，判断用户是否有想看到图片的意图。
如果有，调用 generateAnimeImage 工具生成图片。如果没有，什么都不做直接回复"无需生图"。

调用规则：
- tags：Danbooru 风格标签（英文，逗号分隔）。必须包含人物数量标签（1girl/2girls/1boy 1girl等）和画面描述。
- includeSelf：画「当前对话角色自己」时设为true（如"看看腿""自拍""比个心"）；画其他角色/物体/风景设为false。
  画其他角色时，tags中需包含完整外貌描述（发色、瞳色、发型等）。
- orientation：portrait/landscape/square

示例：
- 用户说"看看腿" → includeSelf:true, tags:"1girl, bare legs, thighs, sitting, looking at viewer, close-up"
- 用户说"画一只知更鸟" → includeSelf:false, tags:"no humans, robin (bird), perched, branch, nature, blue feathers"
- 用户说"和银狼合照" → includeSelf:true, tags:"2girls, standing, smile, looking at viewer, silver wolf (honkai: star rail), short hair, grey hair"

以下情况应该生图：
- 用户明确要求画画、看图、看某个场景
- 用户描述了想看的画面（如"看看腿"、"穿泳装"、"比个心"等）
- 对话语境中有明显的视觉画面暗示

以下情况不生图：
- 普通闲聊没有视觉相关内容
- 用户在讨论非画面相关话题
- 已经在同一轮对话中生成过图片`

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

  const recentHistory = conversationHistory
    .filter(item => item.role === "user" || item.role === "model")
    .slice(-4)

  try {
    const response = await getAI(
      channel,
      e,
      [{ text: `用户刚才说：「${userText}」\n请判断是否有生图意图。` }],
      IMAGE_INTENT_PROMPT,
      false,
      true,
      recentHistory,
    )

    if (typeof response === "string") return

    const functionCalls = response.functionCalls
    if (functionCalls && functionCalls.length > 0) {
      const hasImageCall = functionCalls.some(fc => fc.name === "generateAnimeImage")
      if (hasImageCall) {
        const imageCalls = functionCalls.filter(fc => fc.name === "generateAnimeImage")
        await executeToolCalls(e, imageCalls)
        logger.info("[ImageIntent] 检测到生图意图，已生成图片")
      }
    }
  } catch (err) {
    logger.warn(`[ImageIntent] 意图检测失败: ${err.message}`)
  }
}
