$html = (Invoke-WebRequest "https://uon-tickets.vercel.app/" -UseBasicParsing -TimeoutSec 30).Content
$checks = @(
  'function openCheckout()',
  'function changeQty(',
  'onclick="openCheckout()"',
  'onclick="changeQty(',
  'onclick="openCheckout()" id="checkoutBtn"',
  'class="qty-btn"',
  'renderTickets'
)
foreach ($c in $checks) {
  if ($html -match [regex]::Escape($c)) { Write-Output ("OK   " + $c) } else { Write-Output ("MISS " + $c) }
}
Write-Output ("checkoutBtn present: " + ($html -match 'id="checkoutBtn"'))