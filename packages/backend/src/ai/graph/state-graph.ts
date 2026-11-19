/**
 * StateGraph - LangGraph-compatible bounded state machine workflow engine
 *
 * Implements explicit state, typed nodes, conditional edges, bounded loops,
 * and execution tracing as specified in 07_AI_AGENT_DESIGN.md Section 6.
 */

export const START = '__START__';
export const END = '__END__';

export interface StateGraphNode<TState> {
  name: string;
  fn: (state: TState) => Promise<Partial<TState>> | Partial<TState>;
}

export type ConditionFn<TState> = (
  state: TState
) => string | Promise<string>;

export interface ConditionalEdge<TState> {
  from: string;
  condition: ConditionFn<TState>;
  mapping?: Record<string, string>;
}

export interface GraphStepTrace<TState> {
  step: number;
  node: string;
  durationMs: number;
  stateSnapshot: Partial<TState>;
  error?: string;
}

export interface GraphExecutionResult<TState> {
  finalState: TState;
  steps: GraphStepTrace<TState>[];
  totalSteps: number;
  durationMs: number;
  completedNode: string;
}

export class StateGraph<TState extends Record<string, any>> {
  private nodes = new Map<string, StateGraphNode<TState>>();
  private edges = new Map<string, string>();
  private conditionalEdges = new Map<string, ConditionalEdge<TState>>();
  private entryPoint: string = START;

  /**
   * Register a processing node in the state graph.
   */
  public addNode(
    name: string,
    fn: (state: TState) => Promise<Partial<TState>> | Partial<TState>
  ): this {
    if (name === START || name === END) {
      throw new Error(`Cannot register node with reserved name '${name}'`);
    }
    this.nodes.set(name, { name, fn });
    return this;
  }

  /**
   * Register a direct edge from one node to another.
   */
  public addEdge(from: string, to: string): this {
    if (from !== START && !this.nodes.has(from)) {
      throw new Error(`Edge source node '${from}' does not exist`);
    }
    if (to !== END && !this.nodes.has(to)) {
      throw new Error(`Edge destination node '${to}' does not exist`);
    }
    this.edges.set(from, to);
    return this;
  }

  /**
   * Register a conditional edge that decides the next node based on state.
   */
  public addConditionalEdge(
    from: string,
    condition: ConditionFn<TState>,
    mapping?: Record<string, string>
  ): this {
    if (from !== START && !this.nodes.has(from)) {
      throw new Error(`Edge source node '${from}' does not exist`);
    }
    this.conditionalEdges.set(from, { from, condition, mapping });
    return this;
  }

  /**
   * Set the initial entry point of the graph.
   */
  public setEntryPoint(nodeName: string): this {
    if (!this.nodes.has(nodeName)) {
      throw new Error(`Entry point node '${nodeName}' does not exist`);
    }
    this.entryPoint = nodeName;
    return this;
  }

  /**
   * Compile the graph into an executable runnable.
   */
  public compile(): CompiledStateGraph<TState> {
    if (this.nodes.size === 0) {
      throw new Error('Cannot compile empty StateGraph without nodes');
    }
    const entry = this.edges.get(START) || this.entryPoint;
    if (entry === START || !this.nodes.has(entry)) {
      throw new Error(`Invalid entry point '${entry}' for compiled StateGraph`);
    }

    return new CompiledStateGraph<TState>(
      new Map(this.nodes),
      new Map(this.edges),
      new Map(this.conditionalEdges),
      entry
    );
  }
}

export class CompiledStateGraph<TState extends Record<string, any>> {
  constructor(
    private nodes: Map<string, StateGraphNode<TState>>,
    private edges: Map<string, string>,
    private conditionalEdges: Map<string, ConditionalEdge<TState>>,
    private entryPoint: string
  ) {}

  /**
   * Execute the graph until a terminal node (END), max steps, or timeout is reached.
   */
  public async invoke(
    initialState: TState,
    options: {
      maxSteps?: number;
      timeoutMs?: number;
      onStep?: (trace: GraphStepTrace<TState>) => void;
    } = {}
  ): Promise<GraphExecutionResult<TState>> {
    const maxSteps = options.maxSteps ?? 25;
    const timeoutMs = options.timeoutMs ?? 30000;
    const startTime = Date.now();
    let currentState: TState = { ...initialState };
    const stepTraces: GraphStepTrace<TState>[] = [];

    let currentNodeName: string | undefined = this.entryPoint;
    let stepCount = 0;

    while (currentNodeName && currentNodeName !== END) {
      stepCount++;
      if (stepCount > maxSteps) {
        throw new Error(
          `StateGraph loop boundary exceeded maximum allowed steps (${maxSteps}). Terminating to prevent infinite cycle.`
        );
      }

      if (Date.now() - startTime > timeoutMs) {
        throw new Error(
          `StateGraph execution timed out after ${timeoutMs}ms at node '${currentNodeName}'`
        );
      }

      const node = this.nodes.get(currentNodeName);
      if (!node) {
        throw new Error(`StateGraph execution referenced unknown node '${currentNodeName}'`);
      }

      const nodeStartTime = Date.now();
      try {
        const patch = await Promise.resolve(node.fn(currentState));
        currentState = { ...currentState, ...patch };

        const durationMs = Date.now() - nodeStartTime;
        const trace: GraphStepTrace<TState> = {
          step: stepCount,
          node: currentNodeName,
          durationMs,
          stateSnapshot: { ...patch },
        };
        stepTraces.push(trace);
        options.onStep?.(trace);
      } catch (err: any) {
        const durationMs = Date.now() - nodeStartTime;
        stepTraces.push({
          step: stepCount,
          node: currentNodeName,
          durationMs,
          stateSnapshot: {},
          error: err?.message || String(err),
        });
        throw err;
      }

      // Determine next node
      const condEdge = this.conditionalEdges.get(currentNodeName);
      if (condEdge) {
        const rawNext = await Promise.resolve(condEdge.condition(currentState));
        const mappedNext = condEdge.mapping ? condEdge.mapping[rawNext] ?? rawNext : rawNext;
        currentNodeName = mappedNext;
      } else {
        currentNodeName = this.edges.get(currentNodeName) ?? END;
      }
    }

    return {
      finalState: currentState,
      steps: stepTraces,
      totalSteps: stepCount,
      durationMs: Date.now() - startTime,
      completedNode: currentNodeName || END,
    };
  }
}
