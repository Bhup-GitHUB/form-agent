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
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
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
    // Wait for Google Forms to load
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    return await page.evaluate(() => {
      const fields: FormField[] = [];
      
      // Debug: Log what we find on the page
      console.log('Page title:', document.title);
      console.log('All inputs found:', document.querySelectorAll('input').length);
      console.log('All textareas found:', document.querySelectorAll('textarea').length);
      console.log('All selects found:', document.querySelectorAll('select').length);
      
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
      
      // Extract Google Forms specific elements
      // Look for Google Forms question containers
      const questionContainers = document.querySelectorAll('[data-params*="question"], .freebirdFormviewerViewItemsItemItem, .m2');
      console.log('Question containers found:', questionContainers.length);
      
      questionContainers.forEach((container: Element, containerIndex: number) => {
        // Find the question text
        const questionText = container.querySelector('.freebirdFormviewerViewItemsItemItemTitle, .m7, h1, h2, h3, h4, h5, h6')?.textContent?.trim() || `Question ${containerIndex + 1}`;
        console.log(`Processing question: ${questionText}`);
        
        // Look for radio buttons in this container
        const radioInputs = container.querySelectorAll('input[type="radio"]');
        if (radioInputs.length > 0) {
          const radioGroup: FormField = {
            type: 'radio',
            label: questionText,
            name: `question_${containerIndex}`,
            required: false,
            options: [] as string[],
            element: radioInputs[0]
          };
          
          radioInputs.forEach((input: Element) => {
            const optionText = input.closest('label')?.textContent?.trim() || 
                              input.getAttribute('aria-label') || 
                              (input as HTMLInputElement).value || 
                              'Option';
            radioGroup.options!.push(optionText);
          });
          
          fields.push(radioGroup);
          console.log(`Added radio group: ${questionText} with ${radioGroup.options!.length} options`);
        }
        
        // Look for checkboxes in this container
        const checkboxes = container.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach((checkbox: Element, checkboxIndex: number) => {
          const checkboxText = checkbox.closest('label')?.textContent?.trim() || 
                              checkbox.getAttribute('aria-label') || 
                              `Checkbox ${checkboxIndex + 1}`;
          fields.push({
            type: 'checkbox',
            label: `${questionText} - ${checkboxText}`,
            name: `question_${containerIndex}_checkbox_${checkboxIndex}`,
            required: false,
            element: checkbox
          });
        });
        
        // Look for text inputs in this container
        const textInputs = container.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea, input:not([type])');
        textInputs.forEach((input: Element, inputIndex: number) => {
          fields.push({
            type: input.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text',
            label: questionText,
            name: `question_${containerIndex}_text_${inputIndex}`,
            required: (input as HTMLInputElement).required,
            element: input
          });
        });
        
        // Look for dropdowns in this container
        const selects = container.querySelectorAll('select');
        selects.forEach((select: Element, selectIndex: number) => {
          const options = Array.from((select as HTMLSelectElement).options).map((option: HTMLOptionElement) => option.text);
          fields.push({
            type: 'select',
            label: questionText,
            name: `question_${containerIndex}_select_${selectIndex}`,
            required: (select as HTMLSelectElement).required,
            options: options,
            element: select
          });
        });
      });

      // Fallback: Extract any remaining inputs not in question containers
      const allInputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], textarea, input:not([type])');
      console.log('Fallback inputs found:', allInputs.length);
      
      allInputs.forEach((input: Element, index: number) => {
        // Skip if already processed in question containers
        if (input.closest('[data-params*="question"], .freebirdFormviewerViewItemsItemItem, .m2')) return;
        
        const label = findLabelForInput(input);
        console.log(`Fallback text input ${index}:`, label, input);
        fields.push({
          type: input.tagName.toLowerCase() === 'textarea' ? 'textarea' : 'text',
          label: label,
          name: (input as HTMLInputElement).name || `field_${index}`,
          required: (input as HTMLInputElement).required,
          element: input
        });
      });


      console.log('Total fields extracted:', fields.length);
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
                // Find radio buttons that match the field label and value
                const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
                const radio = radios.find(el => {
                  const label = el.closest('label')?.textContent?.trim() || '';
                  const container = el.closest('[data-params*="question"], .freebirdFormviewerViewItemsItemItem, .m2');
                  const questionText = container?.querySelector('.freebirdFormviewerViewItemsItemItemTitle, .m7, h1, h2, h3, h4, h5, h6')?.textContent?.trim() || '';
                  
                  return (label.includes(fieldValue) || fieldValue.includes(label)) && 
                         questionText.includes(fieldLabel);
                });
                if (radio) {
                  (radio as HTMLInputElement).click();
                  console.log(`Selected radio option: ${fieldValue} for question: ${fieldLabel}`);
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

      if (fields.length === 0) {
        console.log('No form fields found. This might be because:');
        console.log('1. The form is not fully loaded yet');
        console.log('2. The form requires authentication');
        console.log('3. The form uses a different structure than expected');
        console.log('4. The form URL is incorrect');
        console.log('Please check the browser window to see the actual form.');
        return;
      }

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
if (process.env.GEMINI_API_KEY) {
  main();
} else {
  console.log('GoogleFormAgent is ready to use!');
  console.log('Set GEMINI_API_KEY environment variable and uncomment the main() call to run the example.');
  console.log('Usage: GEMINI_API_KEY=your_key_here bun run index.ts');
}

export { GoogleFormAgent };