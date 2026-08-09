import axios from "axios"
import fs from "node:fs"
import path from "node:path"
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
        case "%rebalance_multiplier%":
          node.inputs[key] = params.isNsfw ? 4.0 : 1.0
          break
        case "%rebalance_weights%":
          node.inputs[key] = params.isNsfw
            ? "1.0,1.0,1.0,1.0,1.0,1.0,1.0,2.5,5.0,1.1,4.0,1.0"
            : "1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0"
          break
      }
    }
  }

  return { workflow: replaced, seed }
}

async function uploadImage(apiUrl, imageBuffer, filename) {
  const boundary = `----FormBoundary${Date.now().toString(16)}`
  const CRLF = "\r\n"

  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="image"; filename="${filename}"`,
    "Content-Type: image/png",
    "",
  ].join(CRLF)

  const overwriteField = [
    "",
    `--${boundary}`,
    `Content-Disposition: form-data; name="overwrite"`,
    "",
    "true",
    `--${boundary}--`,
    "",
  ].join(CRLF)

  const body = Buffer.concat([
    Buffer.from(header + CRLF),
    imageBuffer,
    Buffer.from(overwriteField),
  ])

  const res = await axios.post(`${apiUrl}/upload/image`, body, {
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    timeout: 30000,
  })

  if (res.data?.name) {
    return res.data.name
  }
  throw new Error("上传图片失败：未返回文件名")
}

function cleanupUploadedImage(apiUrl, filename) {
  setTimeout(async () => {
    try {
      await axios.post(`${apiUrl}/api/delete/input/${encodeURIComponent(filename)}`, null, { timeout: 5000 })
      logger.info(`[ComfyUI] 已清理参考图: ${filename}`)
    } catch {
      logger.debug(`[ComfyUI] 清理参考图失败（可忽略）: ${filename}`)
    }
  }, 5000)
}

async function pollResult(apiUrl, promptId, timeoutMs = 180000) {
  const startTime = Date.now()
  const pollInterval = 1500

  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await axios.get(`${apiUrl}/history/${promptId}`, { timeout: 10000 })
      const history = res.data

      if (promptId in history) {
        const status = history[promptId]?.status
        if (status?.status_str === "error") {
          return { error: "ComfyUI 生成过程中出错" }
        }

        const outputs = history[promptId]?.outputs || {}
        for (const nodeId of Object.keys(outputs)) {
          const output = outputs[nodeId]
          if (output.images && output.images.length > 0) {
            const image = output.images[0]
            const imageUrl = `${apiUrl}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || "")}&type=${encodeURIComponent(image.type || "output")}`
            const imgRes = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 30000 })
            if (imgRes.status === 200) {
              return { imageData: Buffer.from(imgRes.data), seed: null }
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[ComfyUI] 轮询失败: ${err.message}`)
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval))
  }

  return { error: "生成超时（180秒）" }
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

  let referenceImageName = ""
  if (params.referenceImage) {
    try {
      referenceImageName = await uploadImage(apiUrl, params.referenceImage, `_sakura_ref.png`)
      logger.info(`[ComfyUI] 参考图已上传: ${referenceImageName}`)
    } catch (err) {
      logger.error(`[ComfyUI] 参考图上传失败: ${err.message}`)
      return { error: `参考图上传失败: ${err.message}` }
    }
  }

  const { workflow: filledWorkflow, seed } = replacePlaceholders(workflow, {
    positive: params.positive,
    negative: params.negative,
    width,
    height,
    seed: params.seed,
    steps,
    cfg,
    referenceImage: referenceImageName,
    isNsfw: params.isNsfw || false,
  })

  try {
    const res = await axios.post(
      `${apiUrl}/prompt`,
      { prompt: filledWorkflow },
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

    const result = await pollResult(apiUrl, promptId)

    if (referenceImageName) {
      cleanupUploadedImage(apiUrl, referenceImageName)
    }

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
