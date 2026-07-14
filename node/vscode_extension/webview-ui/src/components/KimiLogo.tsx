import { useExtensionImageUrl } from "./hooks/useExtensionImageUrl";

export function KimiLogo({ className }: { className?: string }) {
  const logoUrl = useExtensionImageUrl("kimi-logo.png");

  if (!logoUrl) {
    return null;
  }

  return <img src={logoUrl} alt="Spec Kimi" className={className} aria-label="Spec Kimi" />;
}
