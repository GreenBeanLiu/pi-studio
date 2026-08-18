export type WorkflowValueSchema<T> = { parse: (value: unknown) => T }

export type WorkflowNodePresentation = {
  label: string
  kind: 'source' | 'transform' | 'wait' | 'side-effect' | 'sink'
}

export type WorkflowNodeContext = {
  signal: AbortSignal
  waiting: (reason: string) => void
  resumed: (reason: string) => void
}

export type WorkflowNodeShape = { input: unknown; output: unknown }

export type WorkflowNodeDefinition<K extends string, I, O, C extends WorkflowNodeContext> = {
  type: K
  inputSchema: WorkflowValueSchema<I>
  outputSchema: WorkflowValueSchema<O>
  presentation: WorkflowNodePresentation
  execute: (input: I, context: C) => Promise<O> | O
}

type ErasedWorkflowNodeDefinition<C extends WorkflowNodeContext> = {
  inputSchema: WorkflowValueSchema<unknown>
  outputSchema: WorkflowValueSchema<unknown>
  presentation: WorkflowNodePresentation
  execute: (input: unknown, context: C) => Promise<unknown> | unknown
}

/** Typed workflow-node seam: each node owns validation, execution and presentation. */
export class WorkflowNodeRegistry<
  M extends { [K in keyof M]: WorkflowNodeShape },
  C extends WorkflowNodeContext = WorkflowNodeContext,
> {
  private readonly definitions = new Map<keyof M & string, ErasedWorkflowNodeDefinition<C>>()

  register<T extends keyof M & string>(
    definition: WorkflowNodeDefinition<T, M[T]['input'], M[T]['output'], C>,
  ): this {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Workflow node is already registered: ${definition.type}`)
    }
    this.definitions.set(definition.type, {
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      presentation: definition.presentation,
      execute: (input, context) => definition.execute(input as M[T]['input'], context),
    })
    return this
  }

  execute<T extends keyof M & string>(type: T, input: M[T]['input'], context: C): Promise<M[T]['output']> {
    const definition = this.definitions.get(type)
    if (!definition) return Promise.reject(new Error(`Unsupported workflow node: ${type}`))
    try {
      const parsedInput = definition.inputSchema.parse(input)
      return Promise.resolve(definition.execute(parsedInput, context)).then(
        (output) => definition.outputSchema.parse(output),
      ) as Promise<M[T]['output']>
    } catch (error) {
      return Promise.reject(error)
    }
  }

  list(): Array<{ type: keyof M & string; presentation: WorkflowNodePresentation }> {
    return [...this.definitions].map(([type, definition]) => ({
      type,
      presentation: definition.presentation,
    }))
  }

  types(): Array<keyof M & string> {
    return [...this.definitions.keys()]
  }
}
