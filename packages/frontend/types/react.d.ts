// React and Next.js Monorepo Ambient Declarations

declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}

declare module 'react' {
  export type ReactNode =
    | ReactElement
    | string
    | number
    | boolean
    | null
    | undefined
    | ReactNode[];

  export interface ReactElement<P = any, T extends string | JSXElementConstructor<any> = string | JSXElementConstructor<any>> {
    type: T;
    props: P;
    key: string | null;
  }

  export type JSXElementConstructor<P> = (props: P) => ReactElement<any, any> | null;

  export type FC<P = {}> = (props: P) => ReactElement<any, any> | null;

  export interface CSSProperties {
    [key: string]: any;
  }

  export interface ChangeEvent<T = Element> {
    target: T & { value: string; checked?: boolean; files?: FileList | null; name?: string };
  }

  export interface MouseEvent<T = Element> {
    preventDefault(): void;
    stopPropagation(): void;
    target: T;
  }

  export interface FormEvent<T = Element> {
    preventDefault(): void;
    stopPropagation(): void;
  }

  export function useState<T>(initialState: T | (() => T)): [T, (newState: T | ((prevState: T) => T)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly any[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly any[] | undefined): T;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly any[]): T;
  export function useRef<T>(initialValue?: T): { current: T };
  export function createContext<T>(defaultValue: T): any;
  export function useContext<T>(context: any): T;
  
  const React: any;
  export default React;
}

declare module 'react-dom' {
  export function createPortal(children: any, container: any): any;
}

declare module 'react-dom/client' {
  export function createRoot(container: any): any;
}

declare module 'next/link' {
  import { FC, ReactNode } from 'react';
  export interface LinkProps {
    href: string;
    className?: string;
    children?: ReactNode;
    onClick?: (e: any) => void;
    target?: string;
    rel?: string;
    [key: string]: any;
  }
  const Link: FC<LinkProps>;
  export default Link;
}

declare module 'next/navigation' {
  export function useRouter(): {
    push(url: string): void;
    replace(url: string): void;
    back(): void;
    prefetch(url: string): void;
  };
  export function usePathname(): string;
  export function useSearchParams(): {
    get(name: string): string | null;
    getAll(name: string): string[];
    has(name: string): boolean;
  };
}

declare module 'clsx' {
  export type ClassValue = string | number | boolean | undefined | null | { [key: string]: any } | ClassValue[];
  export function clsx(...inputs: ClassValue[]): string;
  export default clsx;
}

declare module 'tailwind-merge' {
  export function twMerge(...classLists: (string | undefined | null | boolean)[]): string;
}

declare module 'lucide-react' {
  import { FC } from 'react';
  export interface IconProps {
    className?: string;
    size?: number | string;
    color?: string;
    strokeWidth?: number | string;
  }
  export const ArrowRight: FC<IconProps>;
  export const ArrowLeft: FC<IconProps>;
  export const ArrowUp: FC<IconProps>;
  export const ArrowDown: FC<IconProps>;
  export const ArrowUpDown: FC<IconProps>;
  export const Check: FC<IconProps>;
  export const CheckCircle: FC<IconProps>;
  export const CheckCircle2: FC<IconProps>;
  export const AlertTriangle: FC<IconProps>;
  export const AlertCircle: FC<IconProps>;
  export const AlertOctagon: FC<IconProps>;
  export const X: FC<IconProps>;
  export const XCircle: FC<IconProps>;
  export const Search: FC<IconProps>;
  export const RefreshCw: FC<IconProps>;
  export const Database: FC<IconProps>;
  export const Server: FC<IconProps>;
  export const Play: FC<IconProps>;
  export const Pause: FC<IconProps>;
  export const Square: FC<IconProps>;
  export const RotateCcw: FC<IconProps>;
  export const Shield: FC<IconProps>;
  export const ShieldCheck: FC<IconProps>;
  export const ShieldAlert: FC<IconProps>;
  export const Sparkles: FC<IconProps>;
  export const Sparkle: FC<IconProps>;
  export const Bot: FC<IconProps>;
  export const Send: FC<IconProps>;
  export const Download: FC<IconProps>;
  export const Upload: FC<IconProps>;
  export const FileText: FC<IconProps>;
  export const FileCheck: FC<IconProps>;
  export const FileSpreadsheet: FC<IconProps>;
  export const Activity: FC<IconProps>;
  export const GitCompare: FC<IconProps>;
  export const KeyRound: FC<IconProps>;
  export const Key: FC<IconProps>;
  export const Lock: FC<IconProps>;
  export const Unlock: FC<IconProps>;
  export const Eye: FC<IconProps>;
  export const EyeOff: FC<IconProps>;
  export const ChevronRight: FC<IconProps>;
  export const ChevronDown: FC<IconProps>;
  export const ChevronLeft: FC<IconProps>;
  export const ChevronUp: FC<IconProps>;
  export const ChevronsRight: FC<IconProps>;
  export const LayoutDashboard: FC<IconProps>;
  export const Wand2: FC<IconProps>;
  export const Save: FC<IconProps>;
  export const Link: FC<IconProps>;
  export const TrendingUp: FC<IconProps>;
  export const Layers: FC<IconProps>;
  export const Table: FC<IconProps>;
  export const Columns: FC<IconProps>;
  export const Hash: FC<IconProps>;
  export const Filter: FC<IconProps>;
  export const Settings: FC<IconProps>;
  export const Clock: FC<IconProps>;
  export const CheckSquare: FC<IconProps>;
  export const HelpCircle: FC<IconProps>;
  export const Info: FC<IconProps>;
  export const ExternalLink: FC<IconProps>;
  export const Plus: FC<IconProps>;
  export const Trash2: FC<IconProps>;
  export const Edit: FC<IconProps>;
  export const Edit3: FC<IconProps>;
  export const Copy: FC<IconProps>;
  export const GitBranch: FC<IconProps>;
  export const Bell: FC<IconProps>;
  export const Terminal: FC<IconProps>;
  export const Cpu: FC<IconProps>;
  export const HardDrive: FC<IconProps>;
  export const Network: FC<IconProps>;
  export const Zap: FC<IconProps>;
  export const Sliders: FC<IconProps>;
  export const ListChecks: FC<IconProps>;
  export const FileCode: FC<IconProps>;
  export const CornerDownRight: FC<IconProps>;
  export const CheckCheck: FC<IconProps>;
  export const History: FC<IconProps>;
  export const Radio: FC<IconProps>;
  export const Compass: FC<IconProps>;
  export const BarChart3: FC<IconProps>;
  export const Workflow: FC<IconProps>;
  export const Folder: FC<IconProps>;
  export const FolderGit2: FC<IconProps>;
  export const File: FC<IconProps>;
  export const Code: FC<IconProps>;
  export const ListFilter: FC<IconProps>;
  export const Undo: FC<IconProps>;
  export const Gauge: FC<IconProps>;
  export const Globe: FC<IconProps>;
  export const Loader2: FC<IconProps>;
  export const MessageSquare: FC<IconProps>;
  export const Checkbox: FC<IconProps>;
  export const MoreVertical: FC<IconProps>;
  export const MoreHorizontal: FC<IconProps>;
}
