export { ADAPTER_NAME, createFirebaseAdapter } from './adapter.js'
export type {
  CacheTagsOptions,
  FirebaseAdapterOptions,
  FirebaseDeploymentManifest,
  FirebaseFunctionManifest,
  FirebaseFunctionsHttpsOptions,
  FirebaseParamDefinition,
} from './types.js'

// Default adapter instance (zero-config usage via NEXT_ADAPTER_PATH)
import { createFirebaseAdapter } from './adapter.js'

const firebaseAdapter = createFirebaseAdapter()
export default firebaseAdapter
