import axios from "axios"
import setting from "../../setting.js"

const voiceSentThisTurn = new WeakSet()

export class TTSVoiceTool {
  name = "sendVoice"
  description =
    "发送一条语音消息。每轮对话只能调用一次，调用后必须用纯文字结束回复。"

  parameters = {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "要用语音说出的文字内容",
      },
      emotion: {
        type: "string",
        description: "语气情绪，可选值: 开心/吃惊/难过/恐惧。不指定则默认开心",
      },
    },
    required: ["text"],
  }

  function() {
    const config = setting.getConfig("VitsVoice")
    if (!config?.enabled) return null

    const character = config.characters?.[config.defaultCharacter]
    const emotionList = character?.emotions ? Object.keys(character.emotions) : []

    return {
      name: this.name,
      description: this.description + (emotionList.length ? ` 当前可用情绪: ${emotionList.join("/")}` : ""),
      parameters: this.parameters,
    }
  }

  func = async (opts, e) => {
    const { text, emotion } = opts
    if (!text) return "发送语音失败：文字内容不能为空"

    if (voiceSentThisTurn.has(e)) {
      return "本轮已发送过语音，不可重复发送。请直接用文字回复。"
    }

    const config = setting.getConfig("VitsVoice")
    if (!config?.enabled) return "语音功能未启用"

    const { apiUrl, charactersBasePath, defaultCharacter, characters } = config
    if (!apiUrl) return "语音功能未配置 API 地址"

    const charConfig = characters?.[defaultCharacter]
    if (!charConfig) return `未找到角色配置: ${defaultCharacter}`

    const selectedEmotion = emotion && charConfig.emotions?.[emotion] ? emotion : Object.keys(charConfig.emotions)[0]
    const emotionConfig = charConfig.emotions[selectedEmotion]
    if (!emotionConfig) return "未找到情绪配置"

    const referPath = charConfig.referPath || "reference_audios/中文/emotions"
    const refAudioPath = `${charactersBasePath}/${defaultCharacter}/${referPath}/${emotionConfig.file}`

    try {
      const response = await axios.post(
        `${apiUrl}/tts`,
        {
          text,
          text_lang: charConfig.lang || "zh",
          ref_audio_path: refAudioPath,
          prompt_text: emotionConfig.prompt,
          prompt_lang: charConfig.lang || "zh",
          text_split_method: "cut5",
          media_type: "wav",
          streaming_mode: false,
        },
        {
          responseType: "arraybuffer",
          timeout: 30000,
        }
      )

      if (response.status === 200 && response.data?.byteLength > 0) {
        const buffer = Buffer.from(response.data)
        await e.reply(segment.record(buffer))
        voiceSentThisTurn.add(e)
        return "语音已成功发送给用户。现在请直接用文字继续回复，不要再调用任何工具。"
      }
      return "语音生成失败：API 返回空数据"
    } catch (err) {
      const errMsg = err.response?.data
        ? Buffer.from(err.response.data).toString("utf8").substring(0, 200)
        : err.message
      logger.error(`[TTSVoice] 语音生成失败: ${errMsg}`)
      return `语音发送失败: ${err.message}`
    }
  }
}
