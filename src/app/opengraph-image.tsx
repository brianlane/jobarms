import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "JobArms: your AI applies, you interview";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          background: "radial-gradient(800px 400px at 50% 0%, rgba(20,184,166,0.25), #070b14 70%)",
          color: "white",
          fontFamily: "sans-serif"
        }}
      >
        <div style={{ display: "flex", fontSize: 96, fontWeight: 800, letterSpacing: -2 }}>
          <span>Job</span>
          <span style={{ color: "#2dd4bf" }}>Arms</span>
        </div>
        <div
          style={{
            marginTop: 24,
            fontSize: 34,
            color: "#cbd5e1",
            letterSpacing: 6,
            textTransform: "uppercase"
          }}
        >
          Your AI applies. You interview.
        </div>
        <div
          style={{
            marginTop: 48,
            padding: "16px 40px",
            borderRadius: 999,
            background: "#14b8a6",
            color: "#070b14",
            fontSize: 28,
            fontWeight: 700
          }}
        >
          jobarms.com
        </div>
      </div>
    ),
    size
  );
}
