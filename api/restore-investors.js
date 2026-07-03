import { put } from "@vercel/blob";
export default async function handler(req, res) {
  const investors = [
    {"mailingAddress":"","id":"inv_fernando","middleName":"","firstName":"Fernando","lastName":"Montoya","nationality":"Colombian","lang":"es","phone":"","email":"fernando.montoya@mdosas.com"},
    {"mailingAddress":"","id":"inv_dario","middleName":"","firstName":"Dario","lastName":"Montoya","nationality":"Colombian","lang":"es","phone":"","email":"dario.montoya@mdosas.com"}
  ];
  await put("investors.json", JSON.stringify({ investors }), {
    access:"public", contentType:"application/json", allowOverwrite:true, addRandomSuffix:false,
  });
  return res.status(200).json({ ok: true, restored: investors.length });
}
