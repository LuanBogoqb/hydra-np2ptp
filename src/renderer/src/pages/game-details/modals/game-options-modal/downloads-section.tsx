import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@renderer/components";
import { useToast } from "@renderer/hooks";
import type { LibraryGame } from "@types";

interface DownloadsSettingsSectionProps {
  game: LibraryGame;
  deleting: boolean;
  isGameDownloading: boolean;
  repacksLength: number;
  onOpenRepacks: () => void;
  onOpenDownloadFolder: () => Promise<void>;
}

export function DownloadsSettingsSection({
  game,
  deleting,
  isGameDownloading,
  repacksLength,
  onOpenRepacks,
  onOpenDownloadFolder,
}: Readonly<DownloadsSettingsSectionProps>) {
  const { t } = useTranslation("game_details");
  const { showSuccessToast, showErrorToast } = useToast();
  const [converting, setConverting] = useState(false);
  const [np2ptpUri, setNp2ptpUri] = useState(game.download?.np2ptpUri ?? null);

  const handleConvertToNp2ptp = async () => {
    setConverting(true);
    try {
      const result = await window.electron.convertGameToNp2ptp(
        game.shop,
        game.objectId
      );
      setNp2ptpUri(result.uri);
      showSuccessToast(
        t("np2ptp_convert_success"),
        result.verified ? undefined : t("np2ptp_convert_unverified")
      );
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : String(err));
    } finally {
      setConverting(false);
    }
  };

  const handleCopyNp2ptpLink = async () => {
    if (!np2ptpUri) return;
    await navigator.clipboard.writeText(np2ptpUri);
    showSuccessToast(t("np2ptp_link_copied"));
  };

  if (game.shop === "custom") {
    return (
      <p className="game-options-modal__category-note">
        {t("settings_not_available_for_custom_games")}
      </p>
    );
  }

  return (
    <div className="game-options-modal__downloads">
      <div className="game-options-modal__header">
        <h2>{t("downloads_section_title")}</h2>
        <h4 className="game-options-modal__header-description">
          {t("downloads_section_description")}
        </h4>
      </div>

      <div className="game-options-modal__row">
        <Button
          onClick={onOpenRepacks}
          theme="outline"
          disabled={deleting || isGameDownloading || !repacksLength}
        >
          {t("open_download_options")}
        </Button>
        {game.download?.downloadPath && (
          <Button
            onClick={onOpenDownloadFolder}
            theme="outline"
            disabled={deleting}
          >
            {t("open_download_location")}
          </Button>
        )}
      </div>

      {game.download?.progress === 1 && (
        <div className="game-options-modal__row">
          <Button
            onClick={handleConvertToNp2ptp}
            theme="outline"
            disabled={deleting || isGameDownloading || converting}
          >
            {converting ? t("np2ptp_converting") : t("np2ptp_convert")}
          </Button>
          {np2ptpUri && (
            <Button
              onClick={handleCopyNp2ptpLink}
              theme="outline"
              disabled={deleting}
            >
              {t("np2ptp_copy_link")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
