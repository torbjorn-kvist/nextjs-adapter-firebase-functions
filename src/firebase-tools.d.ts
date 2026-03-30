declare module 'firebase-tools' {
  const client: {
    use: (project?: string, options?: { cwd?: string }) => Promise<string>
  }
  export default client
}
