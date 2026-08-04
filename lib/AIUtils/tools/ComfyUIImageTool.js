import setting from "../../setting.js"
import { generateImage, assemblePrompt } from "../../comfyui.js"

export class ComfyUIImageTool {
  name = "generateAnimeImage"
  description =
    "生成动漫风格插画。当聊天中有生图意图（如描述画面、要求画画、想看某个场景等）时使用。用英文提供描述。"

  parameters = {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "用英文描述要生成的画面内容，至少2句话，包含人物动作、场景、氛围等细节",
      },
      tags: {
        type: "string",
        description: "可选的 Danbooru 风格标签（英文，逗号分隔），如 outdoors, cherry blossoms, night sky",
      },
      orientation: {
        type: "string",
        description: "图片方向: portrait(竖版), landscape(横版), square(方形)",
        enum: ["portrait", "landscape", "square"],
      },
    },
    required: ["description"],
  }

  function() {
    const config = setting.getConfig("ComfyUI")
    if (!config?.enabled) return null

    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    }
  }

  func = async (opts, e) => {
    const { description, tags, orientation } = opts
    if (!description) return "生成失败：请提供画面描述"

    const config = setting.getConfig("ComfyUI")
    if (!config?.enabled) return "ComfyUI 图片生成功能未启用"

    const vitsConfig = setting.getConfig("VitsVoice")
    const characterName = vitsConfig?.defaultCharacter
    let characterTags = ""
    if (characterName && vitsConfig?.characters?.[characterName]?.characterTags) {
      characterTags = vitsConfig.characters[characterName].characterTags
    }

    const { positive, negative } = assemblePrompt({
      characterTags,
      tags,
      description,
    })

    let width = config.defaultWidth || 896
    let height = config.defaultHeight || 1152
    if (orientation === "landscape") {
      width = 1152
      height = 896
    } else if (orientation === "square") {
      width = 1024
      height = 1024
    }

    logger.info(`[ComfyUIImage] 正在生成图片...`)
    logger.info(`[ComfyUIImage] positive: ${positive.substring(0, 200)}...`)

    const result = await generateImage({
      positive,
      negative,
      width,
      height,
    })

    if (result.error) {
      logger.error(`[ComfyUIImage] ${result.error}`)
      return `图片生成失败: ${result.error}`
    }

    if (result.imageData) {
      const base64 = result.imageData.toString("base64")
      await e.reply(segment.image(`base64://${base64}`))
      return "图片已生成并发送，禁止回复[图片]"
    }

    return "图片生成失败：未获得图片数据"
  }
}
