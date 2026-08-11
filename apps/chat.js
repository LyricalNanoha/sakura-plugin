import Setting from "../lib/setting.js"
import cfg from "../../../lib/config/config.js"
import { getRolePrompt } from "../lib/RoleHelper.js"
import { getAI } from "../lib/AIUtils/getAI.js"
import {
  loadConversationHistory,
  saveConversationHistory,
} from "../lib/AIUtils/ConversationHistory.js"
import { executeToolCalls } from "../lib/AIUtils/tools/tools.js"
import { parseAtMessage, getQuoteContent } from "../lib/AIUtils/messaging.js"
import { randomEmojiLike, getImg } from "../lib/utils.js"
import { PermissionManager } from "../lib/PermissionManager.js"
import { checkImageIntent } from "../lib/AIUtils/imageIntentDetector.js"
import { retrieveTags, hasArtistRequest, semanticRetrieve, warmup } from "../lib/AIUtils/animaTagRetriever.js"

// 后台预热语义索引
warmup()
export class AIChat extends plugin {
  constructor() {
    super({
      name: "chat",
      dsc: " AI 聊天插件",
      event: "message",
      priority: 1135,
      rule: [
        {
          reg: "",
          fnc: "Chat",
          log: false,
        },
      ],
    })
  }

  get appconfig() {
    return Setting.getConfig("AI")
  }

  checkPermission(e) {
    if (!this.appconfig?.requirePermission) {
      return true
    }
    const masterQQs = Array.isArray(cfg.masterQQ) ? cfg.masterQQ : [cfg.masterQQ]
    if (!e.group_id) {
      return masterQQs.includes(e.sender.user_id)
    }

    return PermissionManager.hasPermission(e.group_id, e.sender.user_id)
  }

  async Chat(e) {
    const config = this.appconfig
    if (!config || !config.profiles || config.profiles.length === 0) {
      return false
    }

    if (!this.checkPermission(e)) {
      return false
    }

    let contentParts = []
    if (e.message && Array.isArray(e.message) && e.message.length > 0) {
      e.message.forEach(msgPart => {
        switch (msgPart.type) {
          case "text":
            contentParts.push(msgPart.text)
            break
          case "at":
            contentParts.push(`@${msgPart.qq}`)
            break
          case "image":
            const seq = e.seq || e.message_seq
            contentParts.push(`[图片]${seq ? `(seq:${seq})` : ""}`)
            break
        }
      })
    }
    let messageText = contentParts.join("").trim()
    if (!messageText) {
      return false
    }

    let textToMatch = messageText
    if (e.message?.[0]?.type === "at") {
      const atText = `@${e.message[0].qq}`
      if (textToMatch.startsWith(atText)) {
        textToMatch = textToMatch.substring(atText.length).trim()
      }
    }

    const isAtBot = e.message?.some(m => m.type === "at" && String(m.qq) === String(e.self_id))

    let isReplyToBot = false
    const replyPart = e.message?.find(m => m.type === "reply")
    if (replyPart && e.group && typeof e.group.getChatHistory === "function") {
      try {
        let history
        if (e.source && e.source.seq) {
          history = await e.group.getChatHistory(e.source.seq, 1)
        } else if (replyPart.id) {
          history = await e.group.getChatHistory(replyPart.id, 1)
        }
        const origSender = history?.[0]?.sender?.user_id
        isReplyToBot = String(origSender) === String(e.self_id)
      } catch (err) {
        logger.debug(`[Chat] 检查回复目标失败: ${err.message}`)
      }
    }

    logger.info(`[Chat] textToMatch="${textToMatch}", isAtBot=${isAtBot}, isReplyToBot=${isReplyToBot}, self_id=${e.self_id}, atSegments=${JSON.stringify(e.message?.filter(m => m.type === "at"))}`)

    const matchedProfile = config.profiles.find(p =>
      textToMatch.startsWith(p.prefix) ||
      (p.atBot && isAtBot) ||
      (p.replyToBot && isReplyToBot)
    )

    if (!matchedProfile) {
      return false
    }

    const { prefix, Channel, GroupContext, History, Tool } = matchedProfile

    let Prompt = matchedProfile.Prompt
    if (matchedProfile.name) {
      const rolePrompt = getRolePrompt(matchedProfile.name, e.group_id)
      if (rolePrompt) Prompt = rolePrompt
    }

    let query
    if (textToMatch.startsWith(prefix)) {
      query = textToMatch.substring(prefix.length).trim()
    } else if (isAtBot) {
      query = messageText.replace(new RegExp(`@${e.self_id}`, "g"), "").trim()
    } else {
      query = messageText
    }

    if (!query) {
      return false
    }

    const quoteContent = await getQuoteContent(e)
    if (quoteContent) {
      query = `(${quoteContent.trim()}) ${query}`
    }

    if (config.enableUserLock) {
      const lockKey = e.isGroup
        ? `sakura:chat:lock:${e.group_id}:${e.user_id}`
        : `sakura:chat:lock:private:${e.user_id}`

      if (await redis.get(lockKey)) {
        logger.info(`[Chat] 用户 ${e.user_id} 的上一条消息仍在处理中，本次触发已忽略。`)
        return false
      }
      await redis.set(lockKey, "1", { EX: 120 })
    }

    try {
      return await this.doChat(e, { ...matchedProfile, Prompt }, query)
    } finally {
      if (config.enableUserLock) {
        const lockKey = e.isGroup
          ? `sakura:chat:lock:${e.group_id}:${e.user_id}`
          : `sakura:chat:lock:private:${e.user_id}`
        await redis.del(lockKey)
      }
    }
  }

  async doChat(e, matchedProfile, query) {
    const { Channel, Prompt, GroupContext, History, Tool } = matchedProfile

    logger.info(`Chat触发`)
    if (e.isGroup && typeof e.group?.setMsgEmojiLike === "function") {
      await randomEmojiLike(e)
    }

    let finalResponseText = ""
    let currentFullHistory = []
    let toolCallCount = 0
    let hasGeneratedImage = false

    try {
      if (History) {
        currentFullHistory = await loadConversationHistory(e, matchedProfile.prefix)
      }

      const imgBase64List = (await getImg(e, false, true)) || []

      // 如果 ComfyUI 启用且消息可能涉及生图，注入 RAG 标签参考
      let ragSuffix = ""
      const comfyConfig = Setting.getConfig("ComfyUI")
      if (comfyConfig?.enabled && /画|图|看|拍|泳|丝|腿|裙|衣|涩|色|脱|穿|selfie|draw/i.test(query)) {
        const includeArtist = hasArtistRequest(query)
        const ragResult = retrieveTags(query, { includeArtist })
        if (ragResult.context) {
          ragSuffix = `\n\n【参考标签】\n${ragResult.context}`
        }
        // 语义增强：关键词匹配不到角色时用向量检索补充
        if (!ragResult.characters || ragResult.characters.length === 0) {
          const semanticResults = await semanticRetrieve(query)
          if (semanticResults.length > 0) {
            const semanticTags = semanticResults
              .map(r => `${r.name}（${r.cnName}）${r.wiki ? " - " + r.wiki.slice(0, 60) : ""}`)
              .join("\n")
            ragSuffix += `\n\n【语义检索补充】\n${semanticTags}`
          }
        }
      }

      const queryParts = [
        { text: query + ragSuffix },
        ...imgBase64List.map((img) => ({
          inlineData: {
            mimeType: img.mimeType,
            data: img.base64,
          },
        })),
      ]
      const { prefix } = matchedProfile

      let currentAIResponse = await getAI(
        Channel,
        e,
        queryParts,
        Prompt,
        GroupContext,
        Tool,
        currentFullHistory,
      )

      if (typeof currentAIResponse === "string") {
        await this.reply(currentAIResponse, true, { recallMsg: 10 })
        return true
      }

      const historyParts = [{ text: query }]
      if (historyParts.length > 0) {
        currentFullHistory.push({ role: "user", parts: historyParts })
      }

      while (true) {
        const textContent = currentAIResponse.text
        const functionCalls = currentAIResponse.functionCalls
        const rawParts = currentAIResponse.rawParts
        let modelResponseParts = []

        if (rawParts && rawParts.length > 0) {
          modelResponseParts = rawParts
        } else {
          if (textContent) {
            modelResponseParts.push({ text: textContent })
          }
          if (functionCalls && functionCalls.length > 0) {
            for (const fc of functionCalls) {
              modelResponseParts.push({ functionCall: fc })
            }
          }
        }

        if (modelResponseParts.length > 0) {
          const modelHistoryItem = { role: "model", parts: modelResponseParts }
          if (typeof currentAIResponse.reasoning_content !== "undefined") {
            modelHistoryItem.reasoning_content = currentAIResponse.reasoning_content
          }
          currentFullHistory.push(modelHistoryItem)
        }

        if (functionCalls && functionCalls.length > 0) {
          toolCallCount++
          if (toolCallCount >= 5) {
            logger.warn(`[Chat] 工具调用次数超过上限，强行结束对话`)
            return true
          }

          const hasVoiceCall = functionCalls.some(fc => fc.name === "sendVoice")

          if (!hasVoiceCall && textContent) {
            const cleanedTextContent = textContent.replace(/\n+$/, "")
            const parsedcleanedTextContent = parseAtMessage(cleanedTextContent)
            await this.reply(parsedcleanedTextContent, true)
          }
          const executedResults = await executeToolCalls(e, functionCalls)

          if (functionCalls.some(fc => fc.name === "generateAnimeImage" || fc.name === "generateImage")) {
            hasGeneratedImage = true
          }

          if (hasVoiceCall) {
            if (History) {
              currentFullHistory.push(...executedResults)
              const historyToSave = currentFullHistory.filter(
                (item) =>
                  item.role === "user" ||
                  (item.role === "model" &&
                    item.parts.every((p) => p.hasOwnProperty("text")))
              )
              await saveConversationHistory(e, historyToSave, prefix)
            }
            if (!hasGeneratedImage) {
              checkImageIntent(e, currentFullHistory, Channel).catch(() => {})
            }
            return true
          }

          currentFullHistory.push(...executedResults)

          currentAIResponse = await getAI(
            Channel,
            e,
            "",
            Prompt,
            GroupContext,
            Tool,
            currentFullHistory,
          )

          if (typeof currentAIResponse === "string") {
            await this.reply(currentAIResponse, true, { recallMsg: 10 })
            return true
          }
        } else if (textContent) {
          // 拦截模型擅自生成的 pollinations/外部图片 URL，转为 ComfyUI 工具调用
          const pollinationsMatch = textContent.match(/https?:\/\/image\.pollinations\.ai\/prompt\/([^\s)?"]+)/)
          if (pollinationsMatch) {
            const comfyConfig = Setting.getConfig("ComfyUI")
            if (comfyConfig?.enabled) {
              const encodedPrompt = pollinationsMatch[1].split("?")[0]
              const decodedTags = decodeURIComponent(encodedPrompt).replace(/%20/g, " ")
              logger.info(`[Chat] 拦截 pollinations URL，转发到 ComfyUI: ${decodedTags.substring(0, 100)}...`)
              const syntheticCall = [{ name: "generateImage", args: { tags: decodedTags, style: "anime" }, id: "intercepted_pollinations" }]
              const interceptResult = await executeToolCalls(e, syntheticCall)
              hasGeneratedImage = true
              currentFullHistory.push(...interceptResult)
              finalResponseText = textContent.replace(/!\[.*?\]\(https?:\/\/image\.pollinations\.ai[^\s)]*\)/g, "").trim()
              break
            }
          }
          finalResponseText = textContent
          break
        }
      }

      if (History) {
        const historyToSave = currentFullHistory.filter(
          (item) =>
            item.role === "user" ||
            (item.role === "model" &&
              item.parts.every((p) => p.hasOwnProperty("text")))
        )
        await saveConversationHistory(e, historyToSave, prefix)
      }

      const msg = parseAtMessage(finalResponseText)
      await this.reply(msg)
      if (!hasGeneratedImage) {
        checkImageIntent(e, currentFullHistory, Channel).catch(() => {})
      }
    } catch (error) {
      logger.error(`Chat处理过程中出现错误: ${error.message}`)
      await this.reply(`处理过程中出现错误: ${error.message}`, true, { recallMsg: 10 })
      return true
    }
    return true
  }
}
