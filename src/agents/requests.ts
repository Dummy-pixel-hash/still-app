import type { AgentInputField, AgentInputRequest } from "./types"

export const requestKey = (execution: string, kind: "question" | "permission", id: string | number) => JSON.stringify([execution, kind, id])

export function inputChoices(field: AgentInputField): Array<{ value: string; name: string; description?: string }> {
  return field.oneOf?.map(option => ({ value: option.const, name: option.title || option.const, description: option.description }))
    || field.enum?.map(value => ({ value, name: value })) || []
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
function validChoices(value: Record<string, unknown>) {
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.some(option => typeof option !== "string"))) return false
  if (value.oneOf !== undefined && (!Array.isArray(value.oneOf) || !value.oneOf.length || value.oneOf.some(option => !record(option) || typeof option.const !== "string" || option.title !== undefined && typeof option.title !== "string" || option.description !== undefined && typeof option.description !== "string"))) return false
  return true
}
export function questionFields(request: AgentInputRequest): { fields: Array<[string, AgentInputField]>; unsupported: string[] } {
  const schema = request.schema
  if (!record(schema) || !record(schema.properties)) return { fields: [], unsupported: ["The agent did not provide a supported question form."] }
  const fields: Array<[string, AgentInputField]> = [], unsupported: string[] = []
  if (["oneOf", "anyOf", "allOf", "$ref"].some(key => key in schema) || schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !Object.prototype.hasOwnProperty.call(schema.properties, key)))) unsupported.push("This form has unsupported requirements.")
  for (const [id, raw] of Object.entries(schema.properties)) {
    const name = record(raw) && typeof raw.title === "string" ? raw.title : id
    if (!record(raw) || !["string", "number", "integer", "boolean", "array"].includes(String(raw.type ?? "string")) || !validChoices(raw)
      || raw.title !== undefined && typeof raw.title !== "string" || raw.description !== undefined && typeof raw.description !== "string"
      || ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"].some(key => raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key])))
      || ["$ref", "anyOf", "allOf", "pattern", "format", "const", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "contains"].some(key => key in raw)
      || raw.type === "array" && (!record(raw.items) || !validChoices(raw.items) || !(raw.items.enum || raw.items.oneOf))) {
      unsupported.push(name); continue
    }
    fields.push([id, raw as AgentInputField])
  }
  return { fields, unsupported }
}

export function validateAnswers(request: AgentInputRequest, answers: Record<string, unknown>) {
  const { fields, unsupported } = questionFields(request)
  const errors: Record<string, string> = Object.create(null), value: Record<string, unknown> = Object.create(null)
  if (unsupported.length || !fields.length) return { value: {}, errors: {}, unsupported: true }
  for (const [id, field] of fields) {
    const answer = Object.prototype.hasOwnProperty.call(answers,id) ? answers[id] : undefined, required = request.schema.required?.includes(id) || false
    const absent = answer === undefined || answer === null || answer === "" || Array.isArray(answer) && !answer.length
    if (absent) { if (required) errors[id] = field.type === "array" ? "Select at least one option." : "Please answer this question."; continue }
    if (field.type === "boolean") {
      if (typeof answer !== "boolean") errors[id] = "Choose a valid answer."
    } else if (field.type === "array") {
      const choices = inputChoices(field.items || {})
      if (!Array.isArray(answer) || answer.some(item => typeof item !== "string" || !choices.some(choice => choice.value === item))) errors[id] = "Choose from the available options."
      else if (field.minItems !== undefined && answer.length < field.minItems) errors[id] = `Select at least ${field.minItems} options.`
      else if (field.maxItems !== undefined && answer.length > field.maxItems) errors[id] = `Select at most ${field.maxItems} options.`
    } else if (field.type === "number" || field.type === "integer") {
      if (typeof answer !== "number" || !Number.isFinite(answer) || field.type === "integer" && !Number.isInteger(answer)) errors[id] = field.type === "integer" ? "Enter a whole number." : "Enter a number."
      else if (field.minimum !== undefined && answer < field.minimum) errors[id] = `Enter ${field.minimum} or more.`
      else if (field.maximum !== undefined && answer > field.maximum) errors[id] = `Enter ${field.maximum} or less.`
    } else if (typeof answer !== "string") errors[id] = "Enter a text answer."
    else {
      const choices = inputChoices(field)
      if (choices.length && !choices.some(choice => choice.value === answer)) errors[id] = "Choose from the available options."
      else if (field.minLength !== undefined && answer.length < field.minLength) errors[id] = `Use at least ${field.minLength} characters.`
      else if (field.maxLength !== undefined && answer.length > field.maxLength) errors[id] = `Use at most ${field.maxLength} characters.`
    }
    if (!errors[id]) value[id] = answer
  }
  return { value: { ...value }, errors: { ...errors }, unsupported: false }
}
