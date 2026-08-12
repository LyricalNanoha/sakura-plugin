import { GroupAdminTool } from "./GroupAdminTool.js"
import { SearchMusicTool } from "./SearchMusicTool.js"
import { SendMusicTool } from "./SendMusicTool.js"
import { ReminderTool } from "./ReminderTool.js"
import { WebFetchTool } from "./WebFetchTool.js"
import { ForwardMessageTool } from "./ForwardMessageTool.js"
import { TTSVoiceTool } from "./TTSVoiceTool.js"
import { ComfyUIImageTool } from "./ComfyUIImageTool.js"
import { DuckDuckGoSearchTool } from "./DuckDuckGoSearchTool.js"
import { TagSearchTool } from "./TagSearchTool.js"

const availableTools = [
  new GroupAdminTool(),
  new SearchMusicTool(),
  new SendMusicTool(),
  new ReminderTool(),
  new WebFetchTool(),
  new ForwardMessageTool(),
  new TTSVoiceTool(),
  new ComfyUIImageTool(),
  new DuckDuckGoSearchTool(),
  new TagSearchTool(),
]

const toolMap = new Map(availableTools.map(tool => [tool.name, tool]))

export function getToolsSchema() {
  return availableTools.map(tool => tool.function()).filter(Boolean)
}

export async function executeToolCalls(e, initialFunctionCalls) {
  let toolExecutionResults = []

  if (!initialFunctionCalls || initialFunctionCalls.length === 0) {
    return toolExecutionResults
  }

  for (const functionCall of initialFunctionCalls) {
    const { name: toolName, args: toolArgs, id: toolCallId } = functionCall

    let toolResultData = null
    const toolToExecute = toolMap.get(toolName)

    if (toolToExecute) {
      logger.info(`正在执行工具："${toolName}" ${JSON.stringify(toolArgs)}`)
      try {
        const rawResult = await toolToExecute.func(toolArgs, e)

        if (typeof rawResult === "string") {
          toolResultData = { message: rawResult }
        } else {
          toolResultData = JSON.parse(JSON.stringify(rawResult || {}))
        }
      } catch (toolError) {
        logger.error(`工具 "${toolName}" 执行失败:`, toolError)
        toolResultData = { error: `工具执行失败: ${toolError.message || "未知错误"}` }
      }
    } else {
      logger.warn(`AI 建议调用未知工具: "${toolName}"。`)
      toolResultData = { error: `未知工具: ${toolName}` }
    }

    const functionResponsePart = {
      functionResponse: {
        name: String(toolName),
        response: toolResultData,
      },
    }

    if (toolCallId) {
      functionResponsePart.functionResponse.id = toolCallId
    }

    toolExecutionResults.push({
      role: "function",
      parts: [functionResponsePart],
    })

    logger.info(
      `${toolName}工具执行结果: ${JSON.stringify(toolExecutionResults[toolExecutionResults.length - 1], null, 2)}`,
    )
  }

  return toolExecutionResults
}
