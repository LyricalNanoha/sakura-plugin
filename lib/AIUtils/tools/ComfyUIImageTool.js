import setting from "../../setting.js"
import { generateImage, assemblePrompt, resolveWorkflow } from "../../comfyui.js"
import { Recall } from "../../utils.js"
import { TOOL_DESCRIPTION, TAGS_DESCRIPTION, STYLE_DESCRIPTION, ARTIST_DESCRIPTION } from "../imagePromptConfig.js"
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
      count: {
        type: "number",
        description: "生成图片数量，1-9张。用户要求多张时设置，默认1。",
      },
      style: {
        type: "string",
        description: STYLE_DESCRIPTION,
        enum: ["anime", "realistic", "anima", "krea2", "k2"],
      },
      artist: {
        type: "string",
        description: ARTIST_DESCRIPTION,
      },
      includeSelf: {
        type: "boolean",
        description: "是否在图中包含「我自己」。设为true时系统会自动注入我的外貌标签。判断逻辑：画我自己/自拍/看腿/换装=true；画我和某人的双人图=true；只画其他角色（不含我）/物体/风景=false。默认false。",
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
      faceSwap: {
        type: "boolean",
        description: "是否进行换脸。当用户要求「换脸」「把脸换成」「用我的脸」「face swap」或@某人要求将脸替换到生成图中时设为true。换脸需要一张人脸源图（用户发送的图片、引用的图片、或@某人的头像）。注意：faceSwap=true 时不要同时设置 hasReferenceImage=true，除非用户明确同时要求参考风格和换脸。默认false。",
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
    const { tags, count = 1, style, artist, includeSelf = false, orientation, hasReferenceImage = false, faceSwap = false, isNsfw = false } = opts
    if (!tags) return "生成失败：请提供画面标签"

    const imageCount = Math.max(1, Math.min(9, Math.floor(count)))
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

    const workflowName = resolveWorkflow({
      style,
      referenceImage: (hasReferenceImage && !faceSwap) ? "placeholder" : null,
    })

    const { positive, negative } = assemblePrompt({
      characterTags,
      artistTags: artist || "",
      tags,
      workflow: workflowName,
      style,
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

    let faceImageBuffer = null
    if (faceSwap) {
      faceImageBuffer = await this._extractReferenceImage(e)
      if (!faceImageBuffer) {
        logger.warn("[ComfyUIImage] 换脸模式未找到人脸源图，将跳过换脸")
      } else {
        logger.info(`[ComfyUIImage] 已获取换脸源图 (${(faceImageBuffer.length / 1024).toFixed(1)}KB)`)
      }
    }

    logger.info(`[ComfyUIImage] 正在生成 ${imageCount} 张图片 (workflow: ${workflowName}, faceSwap: ${!!faceImageBuffer})...`)
    logger.info(`[ComfyUIImage] positive: ${positive.substring(0, 200)}...`)

    const imageSegments = []
    const generateTasks = []
    for (let i = 0; i < imageCount; i++) {
      generateTasks.push(
        generateImage({ positive, negative, width, height, style, referenceImage: referenceImageBuffer, faceImage: faceImageBuffer })
      )
    }

    const results = await Promise.allSettled(generateTasks)
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.imageData) {
        const base64 = r.value.imageData.toString("base64")
        imageSegments.push(segment.image(`base64://${base64}`))
      }
    }

    if (imageSegments.length === 0) {
      return "图片生成失败：未获得图片数据"
    }

    const botName = e.bot?.nickname || "花火"
    const botId = e.self_id || e.bot?.uin

    const forwardNodes = imageSegments.map(img => ({
      message: [img], user_id: botId, nickname: botName,
    }))

    const promptLabel = workflowName.includes("k2") || workflowName.includes("krea") ? "K2" : "Anima"
    forwardNodes.push({
      message: `[${promptLabel}] ${positive}`,
      user_id: botId,
      nickname: botName,
    })

    let sendResult
    try {
      const target = e.group || e.friend
      if (target?.sendForwardMsg) {
        sendResult = await target.sendForwardMsg(forwardNodes)
      } else if (target?.makeForwardMsg) {
        const msg = await target.makeForwardMsg(forwardNodes)
        sendResult = await e.reply(msg)
      } else {
        for (const img of imageSegments) await e.reply(img)
        sendResult = await e.reply(`[${promptLabel}] ${positive.substring(0, 100)}...`)
      }
    } catch (err) {
      logger.warn(`[ComfyUIImage] 转发模式失败，尝试直接发送: ${err.message}`)
      for (const img of imageSegments) await e.reply(img)
    }

    if (isNsfw && nsfwGroupCfg && nsfwGroupCfg.recall !== false) {
      const delay = nsfwGroupCfg.recallDelay || 30
      const msgId = sendResult?.message_id || sendResult?.data?.message_id
      if (msgId) {
        Recall(e, msgId, delay)
        logger.info(`[ComfyUIImage] NSFW 图片将在 ${delay} 秒后自动撤回`)
      }
    }

    return `已生成${imageSegments.length}张图片并发送，禁止回复[图片]`
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
