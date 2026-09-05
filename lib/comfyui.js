import axios from "axios"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import WebSocket from "ws"
import { pluginRoot } from "./path.js"
import setting from "./setting.js"

const WORKFLOW_PRESETS = {
  anima_turbo: { steps: 25, cfg: 4.0 },
  anima29_turbo: { steps: 25, cfg: 4.0 },
  krea2_turbo: { steps: 12, cfg: 1.0 },
  krea2_style_ref: { steps: 12, cfg: 1.0 },
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

/**
 * 在已填充的工作流末尾注入 ReActor 换脸节点。
 * 找到 ETN_SendImageWebSocket 节点，将其图像输入改为 ReActor 输出。
 * 使用链式串联方式注入多个 ReActor 节点（每个节点处理一张脸），避免多脸批量处理导致模糊。
 * @param {object} workflow - 已填充占位符的工作流对象
 * @param {string} faceImageBase64 - 人脸源图片的 base64 字符串
 * @param {object} config - ComfyUI 配置（用于读取 reactor 默认参数）
 */
function injectReactor(workflow, faceImageBase64, config = {}) {
  let wsNodeId = null
  let imageSourceRef = null

  for (const nid of Object.keys(workflow)) {
    const node = workflow[nid]
    if (node.class_type === "ETN_SendImageWebSocket") {
      wsNodeId = nid
      imageSourceRef = node.inputs.images
      break
    }
  }

  if (!wsNodeId || !imageSourceRef) {
    logger.warn("[ComfyUI] ReActor 注入失败: 未找到 ETN_SendImageWebSocket 节点")
    return
  }

  const usedIds = Object.keys(workflow).map(Number).filter(n => !isNaN(n))
  let nextId = Math.max(...usedIds) + 1

  const swapModel = config.reactorSwapModel || "inswapper_128.onnx"
  const faceRestoreModel = config.reactorFaceRestoreModel || "GFPGANv1.4.pth"
  const faceRestoreVisibility = config.reactorFaceRestoreVisibility ?? 1.0
  const maxFaces = config.reactorMaxFaces ?? 6

  const loadImageNodeId = String(nextId++)
  workflow[loadImageNodeId] = {
    class_type: "ETN_LoadImageBase64",
    inputs: { image: faceImageBase64 },
  }

  let currentImageRef = imageSourceRef
  for (let i = 0; i < maxFaces; i++) {
    const reactorNodeId = String(nextId++)
    workflow[reactorNodeId] = {
      class_type: "ReActorFaceSwap",
      inputs: {
        enabled: true,
        input_image: currentImageRef,
        source_image: [loadImageNodeId, 0],
        swap_model: swapModel,
        facedetection: "retinaface_resnet50",
        face_restore_model: faceRestoreModel,
        face_restore_visibility: faceRestoreVisibility,
        codeformer_weight: 0.5,
        detect_gender_input: "no",
        detect_gender_source: "no",
        input_faces_index: String(i),
        source_faces_index: "0",
        console_log_level: 1,
      },
    }
    currentImageRef = [reactorNodeId, 0]
  }

  workflow[wsNodeId].inputs.images = currentImageRef

  logger.info(
    `[ComfyUI] ReActor 链式换脸已注入 (${maxFaces}个节点, swap_model=${swapModel}, face_restore=${faceRestoreModel}, visibility=${faceRestoreVisibility})`
  )
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
  if (style === "krea2" || style === "k2" || style === "realistic") return "krea2_turbo"
  if (style === "anima" || style === "anime") return config?.defaultWorkflow || "anima_turbo"

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

  const width = params.width || config.defaultWidth || 1024
  const height = params.height || config.defaultHeight || 1536
  const steps = params.steps || preset.steps || 8
  const cfg = params.cfg ?? preset.cfg ?? 4.0

  let referenceImageBase64 = ""
  if (params.referenceImage) {
    referenceImageBase64 = Buffer.isBuffer(params.referenceImage)
      ? params.referenceImage.toString("base64")
      : params.referenceImage
    logger.info(`[ComfyUI] 参考图已编码为base64 (${(referenceImageBase64.length / 1024).toFixed(1)}KB)`)
  }

  let faceImageBase64 = ""
  if (params.faceImage) {
    faceImageBase64 = Buffer.isBuffer(params.faceImage)
      ? params.faceImage.toString("base64")
      : params.faceImage
    logger.info(`[ComfyUI] 换脸源图已编码为base64 (${(faceImageBase64.length / 1024).toFixed(1)}KB)`)
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

  if (faceImageBase64) {
    injectReactor(filledWorkflow, faceImageBase64, config)
  }

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
    let prompt = params.tags || "a beautiful high quality image"

    const isAnimeIntent = params.style === "k2" || params.style === "krea2"
      ? /anime|illustration|2[dD]|cel.?shad|cartoon|manga|二次元|动漫/i.test(prompt)
      : false
    if (isAnimeIntent && !/whole scene drawn as/i.test(prompt)) {
      prompt = `The whole scene drawn as 2D anime illustration with cel shading and vibrant colors. ${prompt}`
    }

    return { positive: prompt, negative: negativePrompt }
  }

  // Anima 模型：三段式提示词组装
  const qualityPrefix = config?.qualityPrefix || "score_9, score_8_up, score_7_up, masterpiece, best quality, source_anime, year_2025"
  const negativePrompt = config?.negativePrompt || "worst quality, low quality, score_1, score_2, score_3, score_4, bad anatomy, extra digits"

  const parts = [qualityPrefix]

  // 画师标签（用户指定时才注入）
  if (params.artistTags) {
    parts.push(params.artistTags)
  }

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
