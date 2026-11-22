import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * If a screen crashes, show a friendly message with a Reload button instead of a
 * blank white page. The bottom menu stays usable, so the cashier can keep billing.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen crashed:', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    // Moving to another screen clears the error.
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="space-y-3 rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-gray-200">
        <div className="text-4xl" aria-hidden>
          😕
        </div>
        <p className="font-semibold">Something went wrong on this screen.</p>
        <p className="text-sm text-gray-600">Your saved bills and records are safe. Try again, or use the menu below.</p>
        <button className="min-h-12 rounded-xl bg-brand-700 px-6 font-semibold text-white" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
