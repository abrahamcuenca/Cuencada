/**
 * Redux store (Phase 0 owned; frozen). Phase-1 tracks add server state through
 * `baseApi.injectEndpoints` instead of new reducers. If a track truly needs
 * client-only state, raise it with the orchestrator first.
 */
import { combineReducers, configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import { authReducer, loggedOut } from "../features/auth/authSlice";
import { baseApi } from "../shared/api/baseApi";
import { cancelOnlineRefreshRetry } from "../shared/api/reauth";

const rootReducer = combineReducers({
  auth: authReducer,
  [baseApi.reducerPath]: baseApi.reducer
});

/** Full state of the app store. */
export type RootState = ReturnType<typeof rootReducer>;

// Internal builder: its inferred return type defines `AppStore`.
function buildStore(preloadedState: Partial<RootState> | undefined) {
  const listener = createListenerMiddleware();
  listener.startListening({
    actionCreator: loggedOut,
    effect: (_action, listenerApi) => {
      // A logout while offline must not be undone by the pending "refresh when back online".
      cancelOnlineRefreshRetry();
      listenerApi.dispatch(baseApi.util.resetApiState());
    }
  });

  return configureStore({
    reducer: rootReducer,
    ...(preloadedState === undefined ? {} : { preloadedState }),
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().prepend(listener.middleware).concat(baseApi.middleware)
  });
}

/** Store type returned by {@link makeStore}. */
export type AppStore = ReturnType<typeof buildStore>;
/** Typed dispatch, thunks included. */
export type AppDispatch = AppStore["dispatch"];

/**
 * Creates a store. The app uses the {@link store} singleton; tests call this
 * for an isolated store per test.
 *
 * On `loggedOut` the RTK Query cache is reset [SEC], so member-only data
 * (directory, photos, chat) never lingers in memory after logout or a failed
 * refresh.
 *
 * @param preloadedState - Optional initial state (tests).
 * @returns A configured store.
 */
export function makeStore(preloadedState?: Partial<RootState>): AppStore {
  return buildStore(preloadedState);
}

/** The app's store singleton. */
export const store: AppStore = makeStore();
