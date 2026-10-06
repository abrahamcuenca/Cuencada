import { type UseDispatch, type UseSelector, useDispatch, useSelector } from "react-redux";
import type { AppDispatch, RootState } from "./store";

/** `useDispatch` typed for this store (thunks included). */
export const useAppDispatch: UseDispatch<AppDispatch> = useDispatch.withTypes<AppDispatch>();

/** `useSelector` typed with {@link RootState}. */
export const useAppSelector: UseSelector<RootState> = useSelector.withTypes<RootState>();
