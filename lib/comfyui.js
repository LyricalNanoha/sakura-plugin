import axios from "axios"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import WebSocket from "ws"
import { pluginRoot } from "./path.js"
import setting from "./setting.js"

const WORKFLOW_PRESETS = {
  anima_turbo: { steps: 25, cfg: 4.0 },
  krea2_turbo: { steps: 8, cfg: 1.0 },
  krea2_style_ref: { steps: 8, cfg: 1.0 },
  krea2_raw_style_ref: { steps: 25, cfg: 1.0 },
}

function getWorkflowPath(workflowName) {
  return path.join(pluginRoot, "resources", "workflows", `${workflowName}.json`)
}

function loadWorkflow(workflowName) {
  const filePath = getWorkflowPath(workflowName)
  if (!fs.existsSync(filePath)) {
    throw new Error(`工作流文件不存在: ${filePath}`)
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"))
}

function replacePlaceholders(workflow, params) {
  const replaced = JSON.parse(JSON.stringify(workflow))
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32)

  for (const nodeId of Object.keys(replaced)) {
    const node = replaced[nodeId]
    if (!node.inputs) continue
    for (const key of Object.keys(node.inputs)) {
      const value = node.inputs[key]
      if (typeof value !== "string") continue
      switch (value) {
        case "%prompt%":
          node.inputs[key] = params.positive
          break
        case "%negative_prompt%":
          node.inputs[key] = params.negative
          break
        case "%seed%":
          node.inputs[key] = seed
          break
        case "%width%":
          node.inputs[key] = params.width
          break
        case "%height%":
          node.inputs[key] = params.height
          break
        case "%steps%":
          node.inputs[key] = params.steps
          break
        case "%cfg%":
          node.inputs[key] = params.cfg
          break
        case "%reference_image%":
          node.inputs[key] = params.referenceImage || ""
          break
      }
    }
  }

  return { workflow: replaced, seed }
}

function createWebSocketReceiver(apiUrl, clientId, timeoutMs = 180000) {
  const wsUrl = apiUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`
  let imageBuffer = null
  let resolved = false
  let ws
  let resolvePromise
  let timer

  const resultPromise = new Promise((resolve) => { resolvePromise = resolve })

  const cleanup = () => {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close()
    }
  }

  const done = (result) => {
    if (resolved) return
    resolved = true
    clearTimeout(timer)
    cleanup()
    resolvePromise(result)
  }

  timer = setTimeout(() => {
    done({ error: "生成超时（180秒）" })
  }, timeoutMs)

  const readyPromise = new Promise((resolveReady, rejectReady) => {
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      clearTimeout(timer)
      done({ error: `WebSocket 连接失败: ${err.message}` })
      rejectReady(err)
      return
    }

    ws.on("open", () => {
      logger.debug("[ComfyUI] WebSocket 已连接")
      resolveReady()
    })

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.from(data)
        const pngMagic = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        const jpegMagic = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
        const offset = pngMagic >= 0 ? pngMagic : (jpegMagic >= 0 ? jpegMagic : 4)
        imageBuffer = buf.slice(offset)
        return
      }

      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === "executing" && msg.data?.node === null) {
          if (imageBuffer) {
            done({ imageData: imageBuffer })
          } else {
            done({ error: "执行完成但未收到图片数据" })
          }
        }
        if (msg.type === "execution_error") {
          done({ error: `ComfyUI 执行错误: ${msg.data?.exception_message || "未知错误"}` })
        }
      } catch {}
    })

    ws.on("error", (err) => {
      done({ error: `WebSocket 错误: ${err.message}` })
      rejectReady(err)
    })

    ws.on("close", () => {
      if (!resolved) {
        if (imageBuffer) {
          done({ imageData: imageBuffer })
        } else {
          done({ error: "WebSocket 连接关闭，未收到图片" })
        }
      }
    })
  })

  return { readyPromise, resultPromise }
}

export function resolveWorkflow(params) {
  const config = setting.getConfig("ComfyUI")

  if (params.workflow) return params.workflow

  if (params.referenceImage) return "krea2_style_ref"

  const style = params.style
  if (style === "realistic" || style === "krea2") return "krea2_turbo"
  if (style === "anime" || style === "anima") return "anima_turbo"

  return config?.defaultWorkflow || "anima_turbo"
}

export async function generateImage(params) {
  const config = setting.getConfig("ComfyUI")
  if (!config?.enabled) {
    return { error: "ComfyUI 图片生成功能未启用" }
  }

  const apiUrl = config.apiUrl?.replace(/\/$/, "")
  if (!apiUrl) {
    return { error: "未配置 ComfyUI API 地址" }
  }

  const workflowName = resolveWorkflow(params)
  const preset = WORKFLOW_PRESETS[workflowName] || {}

  let workflow
  try {
    workflow = loadWorkflow(workflowName)
  } catch (err) {
    return { error: err.message }
  }

  const width = params.width || config.defaultWidth || 896
  const height = params.height || config.defaultHeight || 1152
  const steps = params.steps || preset.steps || 8
  const cfg = params.cfg ?? preset.cfg ?? 4.0

  let referenceImageBase64 = ""
  if (params.referenceImage) {
    referenceImageBase64 = Buffer.isBuffer(params.referenceImage)
      ? params.referenceImage.toString("base64")
      : params.referenceImage
    logger.info(`[ComfyUI] 参考图已编码为base64 (${(referenceImageBase64.length / 1024).toFixed(1)}KB)`)
  }

  const { workflow: filledWorkflow, seed } = replacePlaceholders(workflow, {
    positive: params.positive,
    negative: params.negative,
    width,
    height,
    seed: params.seed,
    steps,
    cfg,
    referenceImage: referenceImageBase64,
  })

  try {
    const clientId = crypto.randomUUID()
    const { readyPromise, resultPromise } = createWebSocketReceiver(apiUrl, clientId)

    await readyPromise

    const res = await axios.post(
      `${apiUrl}/prompt`,
      { prompt: filledWorkflow, client_id: clientId },
      { timeout: 15000 }
    )

    if (res.data?.error) {
      const nodeErrors = res.data.node_errors || {}
      logger.error(`[ComfyUI] API 错误: ${res.data.error}`, JSON.stringify(nodeErrors, null, 2))
      return { error: `ComfyUI 错误: ${res.data.error}` }
    }

    const promptId = res.data?.prompt_id
    if (!promptId) {
      return { error: "ComfyUI 未返回 prompt_id" }
    }

    logger.info(`[ComfyUI] 任务已提交: ${promptId} (workflow: ${workflowName})`)

    const result = await resultPromise

    if (result.error) {
      return { error: result.error }
    }

    return {
      imageData: result.imageData,
      seed,
      width,
      height,
      workflow: workflowName,
    }
  } catch (err) {
    if (err.response?.status === 400) {
      const errData = err.response?.data
      logger.error(`[ComfyUI] 400 错误详情: ${JSON.stringify(errData, null, 2)}`)
      const nodeErrors = errData?.node_errors
      if (nodeErrors && Object.keys(nodeErrors).length > 0) {
        const firstError = Object.values(nodeErrors)[0]
        return { error: `ComfyUI 节点错误: ${JSON.stringify(firstError?.errors || firstError)}` }
      }
      return { error: `ComfyUI 工作流验证失败: ${errData?.error || "未知错误"}` }
    }
    logger.error(`[ComfyUI] 请求失败: ${err.message}`)
    return { error: `ComfyUI 请求失败: ${err.message}` }
  }
}

export function assemblePrompt(params) {
  const config = setting.getConfig("ComfyUI")

  const workflowName = params.workflow || config?.defaultWorkflow || "anima_turbo"
  const isStyleRef = workflowName.includes("style_ref")
  const isKrea2 = workflowName.startsWith("krea2")

  if (isKrea2) {
    if (isStyleRef) {
      return {
        positive: params.tags || "a beautiful image in the reference style",
        negative: "",
      }
    }
    const negativePrompt = config?.krea2NegativePrompt || "worst quality, low quality, blurry"
    return {
      positive: params.tags || "a beautiful high quality image",
      negative: negativePrompt,
    }
  }

  const qualityPrefix = config?.qualityPrefix || "masterpiece, best quality, score_7, highres, newest, safe"
  const negativePrompt = config?.negativePrompt || "worst quality, low quality, score_1, score_2, score_3, artist name"

  const parts = [qualityPrefix]
  if (params.characterTags) {
    parts.push(params.characterTags)
  }
  if (params.tags) {
    parts.push(params.tags)
  }

  return {
    positive: parts.filter(Boolean).join(", "),
    negative: negativePrompt,
  }
}
