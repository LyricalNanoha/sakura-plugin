import setting from "../../setting.js"
import { generateImage, assemblePrompt } from "../../comfyui.js"

export class ComfyUIImageTool {
  name = "generateAnimeImage"
  description =
    "生成动漫风格插画。当聊天中有生图意图（如描述画面、要求画画、想看某个场景等）时使用。"

  parameters = {
    type: "object",
    properties: {
      tags: {
        type: "string",
        description: "用 Danbooru 风格标签描述画面（英文，逗号分隔）。包含：服装、姿势、表情、场景、动作等。示例: kimono, standing, smile, outdoors, cherry blossoms, looking at viewer, upper body",
      },
      orientation: {
        type: "string",
        description: "图片方向: portrait(竖版), landscape(横版), square(方形)",
        enum: ["portrait", "landscape", "square"],
      },
    },
    required: ["tags"],
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
    const { tags, orientation } = opts
    if (!tags) return "生成失败：请提供画面标签"

    const config = setting.getConfig("ComfyUI")
    if (!config?.enabled) return "ComfyUI 图片生成功能未启用"

    const characterTags = config.characterTags || ""

    const { positive, negative } = assemblePrompt({
      characterTags,
      tags,
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
