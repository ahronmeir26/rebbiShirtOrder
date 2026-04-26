import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

const initialState = {
  loading: true,
  submitting: false,
  success: "",
  error: "",
  preview: null
};

function selectedOrderId() {
  return String(shopify?.data?.selected?.[0]?.id || "").trim();
}

async function postRefundAction(body) {
  const response = await fetch("/api/shopify/refund-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

function Extension() {
  const orderId = useMemo(() => selectedOrderId(), []);
  const [state, setState] = useState(initialState);

  useEffect(() => {
    let active = true;

    postRefundAction({ action: "preview", orderId })
      .then((preview) => {
        if (!active) return;
        setState((current) => ({ ...current, loading: false, preview }));
      })
      .catch((error) => {
        if (!active) return;
        setState((current) => ({ ...current, loading: false, error: error.message }));
      });

    return () => {
      active = false;
    };
  }, [orderId]);

  const refund = useCallback(async () => {
    setState((current) => ({ ...current, submitting: true, error: "" }));

    try {
      const result = await postRefundAction({ action: "refund", orderId });
      setState((current) => ({
        ...current,
        submitting: false,
        success: `Stripe refund ${result.refund?.id || "created"} for ${result.order?.name || "this order"}.`
      }));
      setTimeout(() => shopify.close(), 1200);
    } catch (error) {
      setState((current) => ({ ...current, submitting: false, error: error.message }));
    }
  }, [orderId]);

  const close = useCallback(() => shopify.close(), []);
  const orderLabel = state.preview?.order?.name || state.preview?.order?.id || orderId || "this order";
  const canRefund = Boolean(state.preview?.canRefund);
  const disabled = state.loading || state.submitting || !canRefund || Boolean(state.success);

  return (
    <s-admin-action heading="Refund Stripe payment">
      <s-stack direction="block" gap="base">
        {state.loading ? (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner />
            <s-text>Checking refund availability...</s-text>
          </s-stack>
        ) : null}

        {state.error ? <s-banner tone="critical">{state.error}</s-banner> : null}
        {state.preview?.reason && !canRefund ? <s-banner tone="warning">{state.preview.reason}</s-banner> : null}
        {state.success ? <s-banner tone="success">{state.success}</s-banner> : null}

        {!state.loading && !state.success ? (
          <s-box>
            <s-text>
              This will refund the Stripe payment saved by the IVR dashboard for {orderLabel}.
            </s-text>
          </s-box>
        ) : null}
      </s-stack>

      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        disabled={disabled}
        loading={state.submitting}
        onClick={refund}
      >
        Refund
      </s-button>
      <s-button slot="secondary-actions" onClick={close}>
        Close
      </s-button>
    </s-admin-action>
  );
}

export default async () => {
  render(<Extension />, document.body);
};
