import { getAI } from "./getAI.js"
import { executeToolCalls, getImageToolSchema } from "./tools/tools.js"
import setting from "../setting.js"

const IMAGE_INTENT_PROMPT = `你是一个图片生成意图检测器。根据对话上下文，判断用户是否有想看到图片的意图。
如果有，调用 generateImage 工具生成图片。如果没有，什么都不做直接回复"无需生图"。

调用规则：
- tags：根据情况使用不同格式：
  · anime风格（无参考图）：Danbooru 标签（英文逗号分隔），包含人物数量标签(1girl/2girls等)
    示例: "1girl, bare legs, thighs, sitting, looking at viewer, close-up"
  · realistic/krea2风格（无参考图）：英文自然语言描述
    示例: "A photorealistic portrait of a woman sitting on a park bench, soft natural lighting"
  · 有参考图时（hasReferenceImage=true）：必须使用英文自然语言完整句子描述想要的画面
    示例: "A boy playing video games at his gaming desk, wearing a headset, colorful LED lighting in the room"
- style：选择画面风格
  · anime — 动漫二次元风格（默认）
  · realistic — 写实真人照片风格
  · 用户明确说"用krea2""写实""真人""照片风格"→ realistic
  · 用户明确说"用anima""动漫""二次元""插画"→ anime
  · 未指定时默认 anime
- includeSelf：画「当前对话角色自己」时设为true；画其他角色/物体/风景设为false。
- orientation：portrait/landscape/square
- hasReferenceImage：用户是否发送或引用了图片作为参考。如果消息中有图片则设为true。
  注意：有参考图时 tags 必须是自然语言描述，不能用逗号分隔的标签！

示例：
- 用户说"看看腿" → style:"anime", includeSelf:true, tags:"1girl, bare legs, thighs, sitting, looking at viewer, close-up"
- 用户说"画一只知更鸟" → style:"anime", includeSelf:false, tags:"no humans, robin (bird), perched, branch, nature, blue feathers"
- 用户说"用krea2画风景照" → style:"realistic", includeSelf:false, tags:"Breathtaking mountain landscape with a crystal clear lake reflecting the sunset, golden hour lighting"
- 用户发送图片说"参考这个风格画个男生打游戏" → hasReferenceImage:true, tags:"A boy sitting at a gaming desk playing video games, wearing a gaming headset, LED lights in the background"
- 用户@某人说"参考他的头像画一张" → hasReferenceImage:true, tags:"A portrait in the style of the reference image, detailed face, soft lighting"

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

  const hasImage = !!(e.img && e.img.length > 0)

  const recentHistory = conversationHistory
    .filter(item => item.role === "user" || item.role === "model")
    .slice(-10)

  const contextNote = hasImage ? "\n（注意：用户消息中附带了图片）" : ""

  try {
    const response = await getAI(
      channel,
      e,
      [{ text: `用户刚才说：「${userText}」${contextNote}\n请判断是否有生图意图。` }],
      IMAGE_INTENT_PROMPT,
      false,
      getImageToolSchema(),
      recentHistory,
    )

    if (typeof response === "string") return

    const functionCalls = response.functionCalls
    if (functionCalls && functionCalls.length > 0) {
      const imageCalls = functionCalls.filter(fc =>
        fc.name === "generateImage" || fc.name === "generateAnimeImage"
      )
      if (imageCalls.length > 0) {
        for (const fc of imageCalls) {
          if (fc.name === "generateAnimeImage") fc.name = "generateImage"
        }
        await executeToolCalls(e, imageCalls)
        logger.info("[ImageIntent] 检测到生图意图，已生成图片")
      }
    }
  } catch (err) {
    logger.warn(`[ImageIntent] 意图检测失败: ${err.message}`)
  }
}
