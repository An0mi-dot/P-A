!macro customInstall
  ; Cria a pasta "Externo" na raiz do EXTRATJUD — destino de apps externos
  ; (linguagens diferentes, ex.: Protocolos Postais em Python/Tkinter)
  CreateDirectory "$INSTDIR\Externo"
  CreateDirectory "$INSTDIR\Externo\ProtocolosPostais"

  ; Copia o app empacotado (resources/Externo/ProtocolosPostais) para a pasta Externo
  IfFileExists "$INSTDIR\resources\Externo\ProtocolosPostais\ProtocolosPostais.exe" 0 +2
  CopyFiles /SILENT "$INSTDIR\resources\Externo\ProtocolosPostais\ProtocolosPostais.exe" "$INSTDIR\Externo\ProtocolosPostais\"
  IfFileExists "$INSTDIR\resources\Externo\ProtocolosPostais\config.json" 0 +2
  CopyFiles /SILENT "$INSTDIR\resources\Externo\ProtocolosPostais\config.json" "$INSTDIR\Externo\ProtocolosPostais\"
  IfFileExists "$INSTDIR\resources\Externo\ProtocolosPostais\*.xlsx" 0 +2
  CopyFiles /SILENT "$INSTDIR\resources\Externo\ProtocolosPostais\*.xlsx" "$INSTDIR\Externo\ProtocolosPostais\"
  IfFileExists "$INSTDIR\resources\Externo\ProtocolosPostais\LEIA-ME.txt" 0 +2
  CopyFiles /SILENT "$INSTDIR\resources\Externo\ProtocolosPostais\LEIA-ME.txt" "$INSTDIR\Externo\ProtocolosPostais\"
!macroend
