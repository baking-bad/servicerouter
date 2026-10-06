'use client';

/** A page whose data didn't load, such as while the Platform API is down. No detail leaks. */
const PageError = ({ reset }: { readonly error: Error; readonly reset: () => void }) => (
  <div className="container">
    <section className="section stack">
      <span className="eyebrow">Something went wrong</span>
      <h1>This page couldn&apos;t load</h1>
      <p className="lead">The Platform API may be unavailable for a moment.</p>
      <div className="row"><button type="button" className="button button-primary" onClick={reset}>Try again</button><a className="button" href="/">Home</a></div>
    </section>
  </div>
);

export default PageError;
