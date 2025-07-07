import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import getNotes from '@salesforce/apex/NoteController.getNotes';
import saveNote from '@salesforce/apex/NoteController.saveNote';
import deleteNote from '@salesforce/apex/NoteController.deleteNote';
import searchRecords from '@salesforce/apex/NoteController.searchRecords';
import getCategoryPicklistValues from '@salesforce/apex/NoteController.getCategoryPicklistValues';

export default class Note extends LightningElement {
    @api recordId;
    @api objectApiName;
    
    @track notes = [];
    @track showNewNoteForm = false;
    @track showReplyForm = false;
    @track replyToNoteId = '';
    @track newNote = {
        title: '',
        category: '',
        body: '',
        linkedRecords: []
    };
    @track searchTerm = '';
    @track searchResults = [];
    @track categoryOptions = [];
    @track availableObjects = [
        { label: 'Account', value: 'Account' },
        { label: 'Contact', value: 'Contact' },
        { label: 'Opportunity', value: 'Opportunity' },
        { label: 'Case', value: 'Case' },
        { label: 'Lead', value: 'Lead' }
    ];
    
    connectedCallback() {
        this.loadCategoryOptions();
        this.loadNotes();
    }
    
    loadCategoryOptions() {
        getCategoryPicklistValues()
            .then(data => {
                this.categoryOptions = data.map(value => ({
                    label: value,
                    value: value
                }));
                console.log('Category options loaded:', this.categoryOptions);
            })
            .catch(error => {
                console.error('Failed to load categories:', error);
                this.showToast('Error', 'Failed to load categories', 'error');
            });
    }
    
    loadNotes() {
        console.log('loadNotes called with recordId:', this.recordId, 'objectApiName:', this.objectApiName);
        
        if (!this.recordId || !this.objectApiName) {
            console.log('Missing recordId or objectApiName, skipping note load');
            return;
        }
        
        getNotes({ recordId: this.recordId, relatedObject: this.objectApiName })
            .then(result => {
                console.log('getNotes successful, raw result:', result);
                this.notes = this.processNotes(result);
                console.log('Processed notes:', this.notes);
            })
            .catch(error => {
                console.error('Failed to load notes:', error);
                console.error('Error details:', JSON.stringify(error));
                const errorMessage = this.getErrorMessage(error);
                this.showToast('Error', 'Failed to load notes: ' + errorMessage, 'error');
            });
    }
    
    processNotes(rawNotes) {
        console.log('processNotes called with:', rawNotes);
        
        if (!rawNotes || !Array.isArray(rawNotes)) {
            console.log('No notes or invalid data format');
            return [];
        }
        
        // Create a deep copy to avoid proxy issues and group replies under parent notes
        const noteMap = new Map();
        const parentNotes = [];
        
        // First pass: identify parent notes and create copies
        rawNotes.forEach((note, index) => {
            console.log(`Processing note ${index}:`, note);
            
            if (!note.Is_Reply__c) {
                // Create a new object to avoid proxy issues
                const parentNote = {
                    Id: note.Id,
                    Title__c: note.Title__c,
                    Category__c: note.Category__c,
                    Body__c: note.Body__c,
                    Parent_Note__c: note.Parent_Note__c,
                    Is_Reply__c: note.Is_Reply__c,
                    Thread_Count__c: note.Thread_Count__c,
                    CreatedDate: note.CreatedDate,
                    CreatedBy: note.CreatedBy,
                    replies: []
                };
                
                noteMap.set(note.Id, parentNote);
                parentNotes.push(parentNote);
                console.log('Added as parent note:', note.Id);
            }
        });
        
        // Second pass: add replies to parent notes
        rawNotes.forEach((note, index) => {
            if (note.Is_Reply__c && noteMap.has(note.Parent_Note__c)) {
                // Create a copy of the reply
                const replyNote = {
                    Id: note.Id,
                    Title__c: note.Title__c,
                    Category__c: note.Category__c,
                    Body__c: note.Body__c,
                    Parent_Note__c: note.Parent_Note__c,
                    Is_Reply__c: note.Is_Reply__c,
                    Thread_Count__c: note.Thread_Count__c,
                    CreatedDate: note.CreatedDate,
                    CreatedBy: note.CreatedBy
                };
                
                noteMap.get(note.Parent_Note__c).replies.push(replyNote);
                console.log(`Added note ${note.Id} as reply to ${note.Parent_Note__c}`);
            }
        });
        
        console.log('Final processed notes:', parentNotes);
        return parentNotes;
    }
    
    handleNewNote() {
        this.showNewNoteForm = true;
        this.resetNewNote();
    }
    
    handleReply(event) {
        this.replyToNoteId = event.target.dataset.noteId;
        this.showReplyForm = true;
        
        // Find the parent note to copy title and category
        const parentNote = this.notes.find(note => note.Id === this.replyToNoteId);
        
        if (parentNote) {
            // Auto-populate title and category from parent note
            this.newNote = {
                title: 'Re: ' + parentNote.Title__c,
                category: parentNote.Category__c,
                body: '',
                linkedRecords: []
            };
            console.log('Auto-populated reply with title:', this.newNote.title, 'and category:', this.newNote.category);
        } else {
            this.resetNewNote();
        }
    }
    
    handleCancel() {
        this.showNewNoteForm = false;
        this.showReplyForm = false;
        this.resetNewNote();
    }
    
    handleInputChange(event) {
        const field = event.target.dataset.field;
        this.newNote[field] = event.target.value;
    }
    
    handleRichTextChange(event) {
        this.newNote.body = event.target.value;
    }
    
    handleSearchTermChange(event) {
        this.searchTerm = event.target.value;
        console.log('Search term changed to:', this.searchTerm);
        
        if (this.searchTerm.length > 2) {
            console.log('Search term length > 2, performing search');
            this.performSearch();
        } else {
            console.log('Search term too short, clearing results');
            this.searchResults = [];
        }
    }
    
    performSearch() {
        console.log('performSearch() called');
        
        const relatedObjectElement = this.template.querySelector('[data-field="relatedObject"]');
        console.log('Related object element found:', !!relatedObjectElement);
        
        const relatedObject = relatedObjectElement ? relatedObjectElement.value : null;
        console.log('Related object value:', relatedObject);
        console.log('Search term:', this.searchTerm);
        
        if (relatedObject && this.searchTerm) {
            console.log('Calling searchRecords with:', { searchTerm: this.searchTerm, relatedObject: relatedObject });
            
            searchRecords({ searchTerm: this.searchTerm, relatedObject: relatedObject })
                .then(result => {
                    console.log('Search successful:', result);
                    this.searchResults = result;
                })
                .catch(error => {
                    console.error('Search failed:', error);
                    console.error('Search error details:', JSON.stringify(error));
                    this.showToast('Error', 'Search failed: ' + error.body.message, 'error');
                });
        } else {
            console.log('Missing required parameters for search');
            console.log('- relatedObject:', relatedObject);
            console.log('- searchTerm:', this.searchTerm);
        }
    }
    
    handleAddRecord(event) {
        const recordId = event.target.dataset.recordId;
        const recordName = event.target.dataset.recordName;
        const relatedObject = event.target.dataset.objectType;
        
        const existingRecord = this.newNote.linkedRecords.find(r => r.Id === recordId);
        if (!existingRecord) {
            this.newNote.linkedRecords.push({
                Id: recordId,
                Name: recordName,
                RelatedObject: relatedObject
            });
        }
        
        this.searchTerm = '';
        this.searchResults = [];
    }
    
    handleRemoveRecord(event) {
        const recordId = event.target.dataset.recordId;
        this.newNote.linkedRecords = this.newNote.linkedRecords.filter(r => r.Id !== recordId);
    }
    
    handleSave() {
        console.log('Save button clicked');
        console.log('New Note data:', JSON.stringify(this.newNote));
        console.log('Record ID:', this.recordId);
        console.log('Object API Name:', this.objectApiName);
        
        let isFormValid;
        try {
            isFormValid = this.validateForm();
            console.log('Form validation result:', isFormValid);
        } catch (validationError) {
            console.error('Validation error:', validationError);
            return;
        }
        
        if (!isFormValid) {
            console.log('Validation failed - stopping execution');
            return;
        }
        
        console.log('Validation passed - proceeding with save');
        
        // Start with empty arrays
        let linkedRecordIds = [];
        let relatedObjects = [];
        
        // Add linked records if any exist
        if (this.newNote.linkedRecords && this.newNote.linkedRecords.length > 0) {
            linkedRecordIds = this.newNote.linkedRecords.map(r => r.Id);
            relatedObjects = this.newNote.linkedRecords.map(r => r.RelatedObject);
        }
        
        // Always add current record
        linkedRecordIds.push(this.recordId);
        relatedObjects.push(this.objectApiName);
        
        const parentNoteId = this.showReplyForm ? this.replyToNoteId : '';
        
        console.log('About to call saveNote with parameters:');
        console.log('- title:', this.newNote.title);
        console.log('- category:', this.newNote.category);
        console.log('- body:', this.newNote.body);
        console.log('- parentNoteId:', parentNoteId);
        console.log('- linkedRecordIds:', linkedRecordIds);
        console.log('- relatedObjects:', relatedObjects);
        
        // Validate IDs before sending
        console.log('Validating IDs:');
        linkedRecordIds.forEach((id, index) => {
            console.log(`- linkedRecordIds[${index}]: "${id}" (length: ${id ? id.length : 'null'})`);
            if (id && (id.length !== 15 && id.length !== 18)) {
                console.error(`Invalid ID length for linkedRecordIds[${index}]: "${id}"`);
            }
        });
        
        if (parentNoteId) {
            console.log(`- parentNoteId: "${parentNoteId}" (length: ${parentNoteId.length})`);
            if (parentNoteId.length !== 15 && parentNoteId.length !== 18) {
                console.error(`Invalid parentNoteId length: "${parentNoteId}"`);
            }
        }
        
        // Validate arrays are same length
        if (linkedRecordIds.length !== relatedObjects.length) {
            console.error('Mismatch between linkedRecordIds and relatedObjects array lengths');
            this.showToast('Error', 'Data validation error: mismatched array lengths', 'error');
            return;
        }
        
        try {
            saveNote({
                title: this.newNote.title,
                category: this.newNote.category,
                body: this.newNote.body,
                parentNoteId: parentNoteId,
                linkedRecordIds: linkedRecordIds,
                relatedObjects: relatedObjects
            })
            .then((result) => {
                console.log('Save successful:', result);
                this.showToast('Success', 'Note saved successfully', 'success');
                this.handleCancel();
                // Small delay to ensure database operations complete, then reload
                setTimeout(() => {
                    this.loadNotes();
                }, 500);
            })
            .catch(error => {
                console.error('Save failed:', error);
                console.error('Error details:', JSON.stringify(error));
                const errorMessage = this.getErrorMessage(error);
                this.showToast('Error', 'Failed to save note: ' + errorMessage, 'error');
            });
        } catch (saveError) {
            console.error('Error calling saveNote:', saveError);
        }
    }
    
    handleDelete(event) {
        const noteId = event.target.dataset.noteId;
        console.log('Attempting to delete note:', noteId);
        
        if (!noteId) {
            console.error('No note ID provided for deletion');
            this.showToast('Error', 'No note ID provided for deletion', 'error');
            return;
        }
        
        deleteNote({ noteId: noteId })
            .then(() => {
                console.log('Delete successful');
                this.showToast('Success', 'Note deleted successfully', 'success');
                // Small delay to ensure database operations complete, then reload
                setTimeout(() => {
                    this.loadNotes();
                }, 500);
            })
            .catch(error => {
                console.error('Delete failed:', error);
                console.error('Delete error details:', JSON.stringify(error));
                const errorMessage = this.getErrorMessage(error);
                this.showToast('Error', 'Failed to delete note: ' + errorMessage, 'error');
            });
    }
    
    validateForm() {
        console.log('Starting form validation');
        
        console.log('Title value:', this.newNote.title);
        console.log('Category value:', this.newNote.category);
        console.log('Body value:', this.newNote.body);
        
        let isValid = true;
        
        if (!this.newNote.title || this.newNote.title.trim() === '') {
            console.log('Title validation failed');
            isValid = false;
        } else {
            console.log('Title validation passed');
        }
        
        if (!this.newNote.category || this.newNote.category.trim() === '') {
            console.log('Category validation failed');
            isValid = false;
        } else {
            console.log('Category validation passed');
        }
        
        if (!this.newNote.body || this.newNote.body.trim() === '') {
            console.log('Body validation failed');
            isValid = false;
        } else {
            console.log('Body validation passed');
        }
        
        console.log('Overall validation result:', isValid);
        return isValid;
    }
    
    resetNewNote() {
        this.newNote = {
            title: '',
            category: '',
            body: '',
            linkedRecords: []
        };
    }
    
    getErrorMessage(error) {
        console.log('getErrorMessage called with:', error);
        console.log('Error type:', typeof error);
        console.log('Error stringified:', JSON.stringify(error));
        
        if (!error) {
            return 'Unknown error occurred';
        }
        
        // Try different possible error structures
        if (error.body && error.body.message) {
            return error.body.message;
        }
        
        if (error.body && error.body.pageErrors && error.body.pageErrors.length > 0) {
            return error.body.pageErrors[0].message;
        }
        
        if (error.body && error.body.fieldErrors) {
            const fieldErrorMessages = [];
            Object.keys(error.body.fieldErrors).forEach(field => {
                error.body.fieldErrors[field].forEach(fieldError => {
                    fieldErrorMessages.push(`${field}: ${fieldError.message}`);
                });
            });
            if (fieldErrorMessages.length > 0) {
                return fieldErrorMessages.join('; ');
            }
        }
        
        if (error.message) {
            return error.message;
        }
        
        if (typeof error === 'string') {
            return error;
        }
        
        return 'Unknown error occurred';
    }
    
    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({
            title: title,
            message: message,
            variant: variant
        }));
    }
    
    get formTitle() {
        return this.showReplyForm ? 'Reply to Note' : 'New Note';
    }
    
    get hasLinkedRecords() {
        return this.newNote.linkedRecords.length > 0;
    }
    
    get hasSearchResults() {
        return this.searchResults.length > 0;
    }
}
