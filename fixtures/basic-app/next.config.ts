import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const nextConfig = {
  adapterPath: require.resolve('adapter-firebase-functions'),
}
export default nextConfig
