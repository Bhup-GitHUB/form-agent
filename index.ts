import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer, { Browser, Page } from 'puppeteer';

interface FormField {
  type: string;
  label: string;
  name: string;
  required: boolean;
  options?: string[];
  element: any;
}

interface FormData {
  [key: string]: string | string[];
}

class GoogleFormAgent {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private browser: Browser | null = null;

  constructor(geminiApiKey: string) {
    this.genAI = new GoogleGenerativeAI(geminiApiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
  }

  async initBrowser(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: false, // Set to true for headless mode
      defaultViewport: null,
      args: ['--start-maximized']
    });
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }

  async navigateToForm(url: string): Promise<Page> {
    if (!this.browser) {
      throw new Error('Browser not initialized. Call initBrowser() first.');
    }

    const page = await this.browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    return page;
  }

  async extractFormFields(page: Page): Promise<FormField[]> {
    return await page.evaluate(() => {
      const fields: FormField[] = [];
      
      // Helper functions defined inside page.evaluate
      function findLabelForInput(input: Element): string {
        // Try to find associated label
        const id = input.getAttribute('id');
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label) return label.textContent?.trim() || '';
        }

        // Try parent label
        const parentLabel = input.closest('label');
        if (parentLabel) {
          return parentLabel.textContent?.trim() || '';
        }

        // Try previous sibling
        let prev = input.previousElementSibling;
        while (prev) {
          if (prev.tagName === 'LABEL' || prev.classList.contains('question')) {
            return prev.textContent?.trim() || '';
          }
          prev = prev.previousElementSibling;
        }

        // Try aria-label
        const ariaLabel = input.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;

        // Try placeholder
        const placeholder = input.getAttribute('placeholder');
        if (placeholder) return placeholder;

        return 'Unknown field';
      }

      function findGroupLabel(input: Element): string {
        const container = input.closest('[role="group"], .form-group, .question-group');
        if (container) {
          const heading = container.querySelector('h1, h2, h3, h4, h5, h6, .question-title');
          if (heading) return heading.textContent?.trim() || '';
        }
        return findLabelForInput(input);
      }
      
      // Extract text inputs
      const textInputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea');
      textInputs.forEach((input: Element, index: number) => {
        const label = findLabelForInput(input);
        fields.push({
          type: input.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text',
          label: label,
          name: (input as HTMLInputElement).name || `field_${index}`,
          required: (input as HTMLInputElement).required,
          element: input
        });
      });

      // Extract radio buttons
      const radioGroups = new Map<string, any>();
      const radioInputs = document.querySelectorAll('input[type="radio"]');
      radioInputs.forEach((input: Element) => {
        const name = (input as HTMLInputElement).name;
        const label = findLabelForInput(input);
        const value = (input as HTMLInputElement).value;
        
        if (!radioGroups.has(name)) {
          radioGroups.set(name, {
            type: 'radio',
            label: findGroupLabel(input),
            name: name,
            required: (input as HTMLInputElement).required,
            options: [],
            element: input
          });
        }
        radioGroups.get(name)!.options.push(value || label);
      });
      
      radioGroups.forEach(group => fields.push(group));

      // Extract checkboxes
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((input: Element, index: number) => {
        const label = findLabelForInput(input);
        fields.push({
          type: 'checkbox',
          label: label,
          name: (input as HTMLInputElement).name || `checkbox_${index}`,
          required: (input as HTMLInputElement).required,
          element: input
        });
      });

      // Extract dropdowns
      const selects = document.querySelectorAll('select');
      selects.forEach((select: Element, index: number) => {
        const options = Array.from((select as HTMLSelectElement).options).map((option: HTMLOptionElement) => option.text);
        const label = findLabelForInput(select);
        fields.push({
          type: 'select',
          label: label,
          name: (select as HTMLSelectElement).name || `select_${index}`,
          required: (select as HTMLSelectElement).required,
          options: options,
          element: select
        });
      });

      return fields;
    });
  }

  async generateFormData(fields: FormField[], context?: string): Promise<FormData> {
    const fieldDescriptions = fields.map(field => {
      let desc = `- ${field.type.toUpperCase()}: "${field.label}"`;
      if (field.required) desc += ' (required)';
      if (field.options) desc += ` Options: [${field.options.join(', ')}]`;
      return desc;
    }).join('\n');

    const prompt = `
You are an intelligent form-filling assistant. Please provide appropriate values for the following form fields based on your knowledge and the context provided.

Context: ${context || 'General form filling with realistic, appropriate data'}

Form Fields:
${fieldDescriptions}

Please respond with a JSON object where each key is the field label and the value is the appropriate data to fill in. For multiple choice fields (radio/select), choose the most appropriate option. For checkboxes, return true/false. For text fields, provide realistic sample data.

Example format:
{
  "Full Name": "John Doe",
  "Email": "john.doe@example.com",
  "Age": "25",
  "Country": "United States",
  "Subscribe to newsletter": true
}

Respond only with the JSON object, no additional text.
    `;

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      // Clean and parse JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No valid JSON found in response');
      }
    } catch (error) {
      console.error('Error generating form data:', error);
      throw error;
    }
  }

  async fillForm(page: Page, fields: FormField[], formData: FormData): Promise<void> {
    for (const field of fields) {
      const value = formData[field.label];
      if (value === undefined || value === null) continue;

      try {
        switch (field.type) {
          case 'text':
          case 'textarea':
            await page.evaluate((fieldLabel: string, fieldValue: string) => {
              function findLabelText(el: Element): string {
                const id = el.getAttribute('id');
                if (id) {
                  const label = document.querySelector(`label[for="${id}"]`);
                  if (label) return label.textContent?.trim() || '';
                }
                const parentLabel = el.closest('label');
                if (parentLabel) {
                  return parentLabel.textContent?.trim() || '';
                }
                const ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel) return ariaLabel;
                const placeholder = el.getAttribute('placeholder');
                if (placeholder) return placeholder;
                return 'Unknown field';
              }
              
              const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea'));
              const input = inputs.find(el => {
                const label = findLabelText(el);
                return label.includes(fieldLabel) || fieldLabel.includes(label);
              });
              if (input) {
                (input as HTMLInputElement).value = fieldValue;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, field.label, String(value));
            break;

          case 'radio':
            if (field.options && field.options.includes(String(value))) {
              await page.evaluate((fieldLabel: string, fieldValue: string) => {
                function findLabelText(el: Element): string {
                  const id = el.getAttribute('id');
                  if (id) {
                    const label = document.querySelector(`label[for="${id}"]`);
                    if (label) return label.textContent?.trim() || '';
                  }
                  const parentLabel = el.closest('label');
                  if (parentLabel) {
                    return parentLabel.textContent?.trim() || '';
                  }
                  const ariaLabel = el.getAttribute('aria-label');
                  if (ariaLabel) return ariaLabel;
                  return 'Unknown field';
                }
                
                function findGroupLabelText(el: Element): string {
                  const container = el.closest('[role="group"], .form-group, .question-group');
                  if (container) {
                    const heading = container.querySelector('h1, h2, h3, h4, h5, h6, .question-title');
                    if (heading) return heading.textContent?.trim() || '';
                  }
                  return findLabelText(el);
                }
                
                const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
                const radio = radios.find(el => {
                  const label = findLabelText(el);
                  const radioValue = (el as HTMLInputElement).value;
                  return (label.includes(fieldValue) || radioValue === fieldValue) && 
                         findGroupLabelText(el).includes(fieldLabel);
                });
                if (radio) {
                  (radio as HTMLInputElement).click();
                }
              }, field.label, String(value));
            }
            break;

          case 'checkbox':
            if (typeof value === 'boolean') {
              await page.evaluate((fieldLabel: string, shouldCheck: boolean) => {
                function findLabelText(el: Element): string {
                  const id = el.getAttribute('id');
                  if (id) {
                    const label = document.querySelector(`label[for="${id}"]`);
                    if (label) return label.textContent?.trim() || '';
                  }
                  const parentLabel = el.closest('label');
                  if (parentLabel) {
                    return parentLabel.textContent?.trim() || '';
                  }
                  const ariaLabel = el.getAttribute('aria-label');
                  if (ariaLabel) return ariaLabel;
                  return 'Unknown field';
                }
                
                const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
                const checkbox = checkboxes.find(el => {
                  const label = findLabelText(el);
                  return label.includes(fieldLabel) || fieldLabel.includes(label);
                });
                if (checkbox) {
                  const isChecked = (checkbox as HTMLInputElement).checked;
                  if (isChecked !== shouldCheck) {
                    (checkbox as HTMLInputElement).click();
                  }
                }
              }, field.label, value);
            }
            break;

          case 'select':
            if (field.options && field.options.includes(String(value))) {
              await page.evaluate((fieldLabel: string, fieldValue: string) => {
                function findLabelText(el: Element): string {
                  const id = el.getAttribute('id');
                  if (id) {
                    const label = document.querySelector(`label[for="${id}"]`);
                    if (label) return label.textContent?.trim() || '';
                  }
                  const parentLabel = el.closest('label');
                  if (parentLabel) {
                    return parentLabel.textContent?.trim() || '';
                  }
                  const ariaLabel = el.getAttribute('aria-label');
                  if (ariaLabel) return ariaLabel;
                  return 'Unknown field';
                }
                
                const selects = Array.from(document.querySelectorAll('select'));
                const select = selects.find(el => {
                  const label = findLabelText(el);
                  return label.includes(fieldLabel) || fieldLabel.includes(label);
                });
                if (select) {
                  (select as HTMLSelectElement).value = fieldValue;
                  select.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }, field.label, String(value));
            }
            break;
        }

        // Small delay between field fills
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.error(`Error filling field "${field.label}":`, error);
      }
    }
  }

  async autoFillGoogleForm(formUrl: string, context?: string): Promise<void> {
    try {
      console.log('Initializing browser...');
      await this.initBrowser();

      console.log('Navigating to form...');
      const page = await this.navigateToForm(formUrl);

      console.log('Extracting form fields...');
      const fields = await this.extractFormFields(page);
      console.log(`Found ${fields.length} fields:`, fields.map(f => f.label));

      console.log('Generating form data using Gemini AI...');
      const formData = await this.generateFormData(fields, context);
      console.log('Generated data:', formData);

      console.log('Filling form...');
      await this.fillForm(page, fields, formData);

      console.log('Form filled successfully! Review and submit manually.');
      
      // Keep browser open for manual review and submission
      console.log('Browser will remain open for manual review. Close it when done.');
      
    } catch (error) {
      console.error('Error in auto-fill process:', error);
      throw error;
    }
  }
}

// Usage example
async function main() {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }
  
  const GOOGLE_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSduovy3vKzVGKomL-AZ-tK1mPuIjww8RrfEBYhZSCliZshMLg/viewform?usp=header';
  
  const agent = new GoogleFormAgent(GEMINI_API_KEY);
  
  try {
    await agent.autoFillGoogleForm(
      GOOGLE_FORM_URL,
      'This is a job application form for a software developer position'
    );
  } catch (error) {
    console.error('Failed to auto-fill form:', error);
  } finally {
    // Browser will close when you manually close it
    // await agent.closeBrowser();
  }
}

// Uncomment to run
main();

export { GoogleFormAgent };