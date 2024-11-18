declare module '*.html' {
  const value: string;
  export = value;
}

interface Env {
  username?: string;
}

declare module '*.png' {
  const value: any;
  export = value;
}

declare module '*.ico' {
  const value: any;
  export = value;
}
