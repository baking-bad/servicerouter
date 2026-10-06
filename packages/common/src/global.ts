export { };

declare global {
  interface ArrayConstructor {
    // Overload the native signature to return 'readonly unknown[]' instead of 'any[]'
    isArray(arg: unknown): arg is readonly unknown[];
  }
}
