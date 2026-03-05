const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const fs = require('fs');

class DocumentReaderService {
  
  async extractText(filePath, mimeType) {
    try {
      if (mimeType.includes('pdf')) {
        return await this.readPDF(filePath);
      } else if (mimeType.includes('word') || mimeType.includes('document')) {
        return await this.readWord(filePath);
      } else if (mimeType.includes('sheet') || mimeType.includes('excel')) {
        return await this.readExcel(filePath);
      } else if (mimeType.includes('text')) {
        return await this.readText(filePath);
      }
      
      return { success: false, error: 'Formato no soportado' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  async readPDF(filePath) {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return { success: true, text: data.text, pages: data.numpages };
  }
  
  async readWord(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });
    return { success: true, text: result.value };
  }
  
  async readExcel(filePath) {
    const workbook = xlsx.readFile(filePath);
    let text = '';
    
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      text += `\n\n=== ${sheetName} ===\n`;
      text += xlsx.utils.sheet_to_txt(sheet);
    });
    
    return { success: true, text };
  }
  
  async readText(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    return { success: true, text };
  }
}

module.exports = new DocumentReaderService();
