import axios from "axios"
import fs from "node:fs"
import path from "node:path"
import { pluginRoot } from "./path.js"
import setting from "./setting.js"

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
      }
    }
  }

  return { workflow: replaced, seed }
}

async function pollResult(apiUrl, promptId, timeoutMs = 120000) {
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

  return { error: "生成超时（120秒）" }
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

  const workflowName = params.workflow || config.defaultWorkflow || "anima_turbo"

  let workflow
  try {
    workflow = loadWorkflow(workflowName)
  } catch (err) {
    return { error: err.message }
  }

  const width = params.width || config.defaultWidth || 896
  const height = params.height || config.defaultHeight || 1152

  const { workflow: filledWorkflow, seed } = replacePlaceholders(workflow, {
    positive: params.positive,
    negative: params.negative,
    width,
    height,
    seed: params.seed,
    steps: params.steps,
    cfg: params.cfg,
  })

  try {
    const res = await axios.post(
      `${apiUrl}/prompt`,
      { prompt: filledWorkflow },
      { timeout: 15000 }
    )

    if (res.data?.error) {
      const nodeErrors = res.data.node_errors || {}
      logger.error(`[ComfyUI] API 错误: ${res.data.error}`, nodeErrors)
      return { error: `ComfyUI 错误: ${res.data.error}` }
    }

    const promptId = res.data?.prompt_id
    if (!promptId) {
      return { error: "ComfyUI 未返回 prompt_id" }
    }

    logger.info(`[ComfyUI] 任务已提交: ${promptId}`)

    const result = await pollResult(apiUrl, promptId)
    if (result.error) {
      return { error: result.error }
    }

    return {
      imageData: result.imageData,
      seed,
      width,
      height,
    }
  } catch (err) {
    logger.error(`[ComfyUI] 请求失败: ${err.message}`)
    return { error: `ComfyUI 请求失败: ${err.message}` }
  }
}

export function assemblePrompt(params) {
  const config = setting.getConfig("ComfyUI")
  const qualityPrefix = config?.qualityPrefix || "masterpiece, best quality, score_7, highres, newest, safe"
  const negativePrompt = config?.negativePrompt || "worst quality, low quality, score_1, score_2, score_3, artist name"

  const parts = [qualityPrefix]

  if (params.characterTags) {
    parts.push(params.characterTags)
  } else {
    parts.push("1girl, solo")
  }

  if (params.tags) {
    parts.push(params.tags)
  }

  const positive = parts.filter(Boolean).join(", ")
  const negative = negativePrompt

  return { positive, negative }
}
