import setting from "../../setting.js"
import { generateImage, assemblePrompt, resolveWorkflow } from "../../comfyui.js"
import { Recall } from "../../utils.js"
import { TOOL_DESCRIPTION, TAGS_DESCRIPTION, STYLE_DESCRIPTION } from "../imagePromptConfig.js"
import axios from "axios"

export class ComfyUIImageTool {
  name = "generateImage"
  description = TOOL_DESCRIPTION

  parameters = {
    type: "object",
    properties: {
      tags: {
        type: "string",
        description: TAGS_DESCRIPTION,
      },
      style: {
        type: "string",
        description: STYLE_DESCRIPTION,
        enum: ["anime", "realistic", "anima", "krea2", "k2"],
      },
      includeSelf: {
        type: "boolean",
        description: "是否在图中画「我自己」（当前角色）。画自己或被要求自拍/看腿等设为true；画其他角色/物体/风景设为false。默认true。",
      },
      orientation: {
        type: "string",
        description: "图片方向: portrait(竖版), landscape(横版), square(方形)",
        enum: ["portrait", "landscape", "square"],
      },
      hasReferenceImage: {
        type: "boolean",
        description: "用户是否提供了参考图片。以下情况设为true：发送了图片、引用了含图消息、或@了某人想参考其头像。默认false。",
      },
      isNsfw: {
        type: "boolean",
        description: "画面是否包含明确的 R18 内容（裸体、露点、性行为等）。仅当描述中明确要求裸露/露点/性交等才设为 true；性感、暗示、擦边但不露点的不算。默认 false。",
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
    const { tags, style, includeSelf = true, orientation, hasReferenceImage = false, isNsfw = false } = opts
    if (!tags) return "生成失败：请提供画面标签"

    const config = setting.getConfig("ComfyUI")
    if (!config?.enabled) return "ComfyUI 图片生成功能未启用"

    const nsfwGroupConfigs = config.nsfwGroupConfigs || []
    const groupId = e.group_id
    let nsfwGroupCfg = null

    if (isNsfw && groupId) {
      nsfwGroupCfg = nsfwGroupConfigs.find(
        c => c.group === groupId || c.group === String(groupId) ||
             (Array.isArray(c.group) && (c.group.includes(groupId) || c.group.includes(String(groupId))))
      )
      if (!nsfwGroupCfg) {
        return "本群未开启 NSFW 图片生成功能"
      }
    }

    const characterTags = includeSelf ? (config.characterTags || "") : ""

    const workflowName = resolveWorkflow({ style, referenceImage: hasReferenceImage ? "placeholder" : null })

    const { positive, negative } = assemblePrompt({
      characterTags,
      tags,
      workflow: workflowName,
    })

    let width = config.defaultWidth || 1024
    let height = config.defaultHeight || 1536
    if (orientation === "landscape") {
      width = 1536
      height = 1024
    } else if (orientation === "square") {
      width = 1024
      height = 1024
    }

    let referenceImageBuffer = null
    if (hasReferenceImage) {
      referenceImageBuffer = await this._extractReferenceImage(e)
      if (!referenceImageBuffer) {
        logger.warn("[ComfyUIImage] 未找到参考图片，回退到普通文生图模式")
      }
    }

    logger.info(`[ComfyUIImage] 正在生成图片 (workflow: ${workflowName})...`)
    logger.info(`[ComfyUIImage] positive: ${positive.substring(0, 200)}...`)

    const result = await generateImage({
      positive,
      negative,
      width,
      height,
      style,
      referenceImage: referenceImageBuffer,
    })

    if (result.error) {
      logger.error(`[ComfyUIImage] ${result.error}`)
      return `图片生成失败: ${result.error}`
    }

    if (result.imageData) {
      const base64 = result.imageData.toString("base64")
      const imgSeg = segment.image(`base64://${base64}`)

      const botName = e.bot?.nickname || "花火"
      const botId = e.self_id || e.bot?.uin

      const forwardNodes = [
        { message: [imgSeg], user_id: botId, nickname: botName },
      ]

      let sendResult
      try {
        const target = e.group || e.friend
        if (target?.sendForwardMsg) {
          sendResult = await target.sendForwardMsg(forwardNodes)
        } else if (target?.makeForwardMsg) {
          const msg = await target.makeForwardMsg(forwardNodes)
          sendResult = await e.reply(msg)
        } else {
          sendResult = await e.reply(imgSeg)
        }
      } catch (err) {
        logger.warn(`[ComfyUIImage] 转发模式失败，尝试直接发送: ${err.message}`)
        sendResult = await e.reply(imgSeg)
      }

      if (isNsfw && nsfwGroupCfg && nsfwGroupCfg.recall !== false) {
        const delay = nsfwGroupCfg.recallDelay || 30
        const msgId = sendResult?.message_id || sendResult?.data?.message_id
        if (msgId) {
          Recall(e, msgId, delay)
          logger.info(`[ComfyUIImage] NSFW 图片将在 ${delay} 秒后自动撤回`)
        }
      }

      return "图片已生成并发送，禁止回复[图片]"
    }

    return "图片生成失败：未获得图片数据"
  }

  async _extractReferenceImage(e) {
    try {
      let imageUrl = null

      if (e.img && e.img.length > 0) {
        imageUrl = e.img[0]
      }

      if (!imageUrl && e.source) {
        const quotedMsg = e.source
        if (quotedMsg?.message) {
          for (const seg of quotedMsg.message) {
            if (seg.type === "image" && seg.url) {
              imageUrl = seg.url
              break
            }
          }
        }
      }

      if (!imageUrl && e.message) {
        for (const seg of e.message) {
          if (seg.type === "image" && (seg.url || seg.file)) {
            imageUrl = seg.url || seg.file
            break
          }
        }
      }

      if (!imageUrl && e.message) {
        for (const seg of e.message) {
          if (seg.type === "at" && seg.qq && String(seg.qq) !== String(e.self_id)) {
            imageUrl = `https://q1.qlogo.cn/g?b=qq&nk=${seg.qq}&s=640`
            logger.info(`[ComfyUIImage] 使用 @${seg.qq} 的头像作为参考图`)
            break
          }
        }
      }

      if (!imageUrl) return null

      const res = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 15000 })
      if (res.status === 200) {
        return Buffer.from(res.data)
      }
    } catch (err) {
      logger.warn(`[ComfyUIImage] 获取参考图失败: ${err.message}`)
    }
    return null
  }
}
